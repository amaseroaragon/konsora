"""Datos SQL anteriores: lectura/migración; sin rutas HTTP registrables.

Las operaciones antiguas se conservan para reproducir bases previas en QA.
"""

import sqlite3
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from konsora_api.text import safe_text
from konsora_api.database import Database
from konsora_api.projects import LocalDatabase, require_project

from konsora_api.task_models import (TaskStatus, AttemptStatus, FinalAttemptStatus, TRANSITIONS, TaskFields, CreateTask, EditTask, ChangeTaskStatus, Task, Attempt, Activity, TaskDetails)


def now() -> str:
    return datetime.now(UTC).isoformat()


def load_task(connection: sqlite3.Connection, project_id: UUID, task_id: UUID) -> Task:
    row = connection.execute("SELECT * FROM tasks WHERE id=? AND project_id=?", (str(task_id), str(project_id))).fetchone()
    if row is None:
        raise HTTPException(404, "La tarea no existe en este proyecto.")
    dependencies = connection.execute(
        """SELECT d.dependency_id, t.status FROM task_dependencies d
           JOIN tasks t ON t.id=d.dependency_id WHERE d.task_id=? ORDER BY d.dependency_id""", (str(task_id),),
    ).fetchall()
    last = connection.execute(
        "SELECT status, error FROM task_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1", (str(task_id),),
    ).fetchone()
    blocked_by = [item["dependency_id"] for item in dependencies if item["status"] != "done"]
    return Task(**dict(row), dependencies=[item["dependency_id"] for item in dependencies],
                blocked_by=blocked_by, blocked=bool(blocked_by),
                last_attempt_status=last["status"] if last else None, last_attempt_error=last["error"] if last else None)


def check_version(task: Task, expected: int) -> None:
    if task.version != expected:
        raise HTTPException(409, "La tarea ha cambiado. Actualízala antes de guardar.")


def check_inactive(connection: sqlite3.Connection, task: Task) -> None:
    if connection.execute("SELECT 1 FROM task_attempts WHERE task_id=? AND status='running'", (str(task.id),)).fetchone():
        raise HTTPException(409, "La tarea tiene un intento activo.")


def activity(connection: sqlite3.Connection, task: Task, event: str, detail: str = "", *, actor: str = "user") -> None:
    connection.execute(
        "INSERT INTO task_activity (task_id, task_version, event, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (str(task.id), task.version, event, actor, safe_text(detail), now()),
    )


def set_dependencies(connection: sqlite3.Connection, project_id: UUID, task_id: UUID, dependencies: list[UUID]) -> None:
    wanted = {str(item) for item in dependencies}
    if str(task_id) in wanted:
        raise HTTPException(422, "Una tarea no puede depender de sí misma.")
    members = {row[0] for row in connection.execute("SELECT id FROM tasks WHERE project_id=?", (str(project_id),))}
    if not wanted <= members:
        raise HTTPException(422, "Todas las dependencias deben existir en este proyecto.")
    graph: dict[str, list[str]] = {}
    for row in connection.execute("SELECT task_id, dependency_id FROM task_dependencies WHERE project_id=?", (str(project_id),)):
        graph.setdefault(row[0], []).append(row[1])
    pending, visited = list(wanted), set()
    while pending:
        node = pending.pop()
        if node == str(task_id):
            raise HTTPException(422, "Las dependencias formarían un ciclo.")
        if node not in visited:
            visited.add(node)
            pending.extend(graph.get(node, []))
    connection.execute("DELETE FROM task_dependencies WHERE task_id=?", (str(task_id),))
    connection.executemany(
        "INSERT INTO task_dependencies (project_id, task_id, dependency_id) VALUES (?, ?, ?)",
        [(str(project_id), str(task_id), item) for item in sorted(wanted)],
    )


def list_tasks(project_id: UUID, database: LocalDatabase) -> list[Task]:
    with database.connect() as connection:
        connection.execute("BEGIN")
        require_project(connection, project_id)
        ids = connection.execute("SELECT id FROM tasks WHERE project_id=? ORDER BY sort_order, created_at, id", (str(project_id),)).fetchall()
        return [load_task(connection, project_id, UUID(row[0])) for row in ids]


def create_task(project_id: UUID, payload: CreateTask, database: LocalDatabase) -> Task:
    task_id, timestamp = uuid4(), now()
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        require_project(connection, project_id)
        order = payload.sort_order
        if order is None:
            order = connection.execute("SELECT COALESCE(MAX(sort_order), -1)+1 FROM tasks WHERE project_id=?", (str(project_id),)).fetchone()[0]
        connection.execute(
            """INSERT INTO tasks (id, project_id, title, description, acceptance_criteria, sort_order, status, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
            (str(task_id), str(project_id), safe_text(payload.title), safe_text(payload.description),
             safe_text(payload.acceptance_criteria), order, payload.status, timestamp, timestamp),
        )
        set_dependencies(connection, project_id, task_id, payload.dependencies)
        task = load_task(connection, project_id, task_id)
        activity(connection, task, "created")
    return task


def open_task(project_id: UUID, task_id: UUID, database: LocalDatabase) -> TaskDetails:
    with database.connect() as connection:
        connection.execute("BEGIN")
        task = load_task(connection, project_id, task_id)
        attempts = [attempt_from_row(row) for row in connection.execute("SELECT * FROM task_attempts WHERE task_id=? ORDER BY rowid", (str(task_id),))]
        events = [Activity.model_validate(dict(row)) for row in connection.execute("SELECT * FROM task_activity WHERE task_id=? ORDER BY id", (str(task_id),))]
        return TaskDetails(task=task, attempts=attempts, activity=events)


def edit_task(project_id: UUID, task_id: UUID, payload: EditTask, database: LocalDatabase) -> Task:
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        previous = load_task(connection, project_id, task_id)
        check_version(previous, payload.expected_version)
        check_inactive(connection, previous)
        if previous.status == "in_progress":
            raise HTTPException(409, "Devuelve la tarea a pendiente antes de editar su alcance.")
        fields = TaskFields.model_validate({
            key: getattr(payload, key) if key in payload.model_fields_set else getattr(previous, key)
            for key in TaskFields.model_fields
        })
        set_dependencies(connection, project_id, task_id, fields.dependencies)
        changed_scope = (previous.title, previous.description, previous.acceptance_criteria, set(previous.dependencies)) != (
            safe_text(fields.title), safe_text(fields.description), safe_text(fields.acceptance_criteria), set(fields.dependencies))
        status = "pending" if changed_scope and previous.status in {"done", "in_review"} else previous.status
        connection.execute(
            """UPDATE tasks SET title=?, description=?, acceptance_criteria=?, sort_order=?, status=?, version=version+1, updated_at=? WHERE id=?""",
            (safe_text(fields.title), safe_text(fields.description), safe_text(fields.acceptance_criteria),
             fields.sort_order, status, now(), str(task_id)),
        )
        task = load_task(connection, project_id, task_id)
        activity(connection, task, "updated", f"{previous.status} → {task.status}")
    return task


def change_status(project_id: UUID, task_id: UUID, payload: ChangeTaskStatus, database: LocalDatabase) -> Task:
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        previous = load_task(connection, project_id, task_id)
        check_version(previous, payload.expected_version)
        check_inactive(connection, previous)
        if payload.status not in TRANSITIONS[previous.status]:
            raise HTTPException(409, "Cambio de estado no permitido. Solo se acepta como hecha una tarea en revisión.")
        if previous.blocked and payload.status in {"in_progress", "in_review", "done"}:
            raise HTTPException(409, "La tarea tiene dependencias sin aceptar.")
        connection.execute("UPDATE tasks SET status=?, version=version+1, updated_at=? WHERE id=?", (payload.status, now(), str(task_id)))
        task = load_task(connection, project_id, task_id)
        activity(connection, task, "status_changed", f"{previous.status} → {task.status}\n{payload.comment}")
    return task


def delete_task(project_id: UUID, task_id: UUID, database: LocalDatabase,
                expected_version: Annotated[int, Query(ge=1)], confirm: Annotated[Literal["true"], Query()]) -> Response:
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = load_task(connection, project_id, task_id)
        check_version(task, expected_version)
        check_inactive(connection, task)
        if task.status == "in_progress":
            raise HTTPException(409, "No se puede borrar una tarea en curso.")
        if connection.execute("SELECT 1 FROM task_dependencies WHERE dependency_id=?", (str(task_id),)).fetchone():
            raise HTTPException(409, "Otras tareas dependen de esta. Retira esas dependencias antes de borrarla.")
        connection.execute("DELETE FROM tasks WHERE id=?", (str(task_id),))
    return Response(status_code=204)


def attempt_from_row(row: sqlite3.Row) -> Attempt:
    data = dict(row)
    data["task_snapshot"] = Task.model_validate_json(data["task_snapshot"])
    return Attempt.model_validate(data)


def start_attempt(database: Database, project_id: UUID, task_id: UUID, *, expected_version: int,
                  connector: str, model: str | None = None) -> Attempt:
    """Registro interno para el futuro supervisor; no autoriza ni ejecuta trabajo."""
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = load_task(connection, project_id, task_id)
        check_version(task, expected_version)
        check_inactive(connection, task)
        if task.status != "pending" or task.blocked:
            raise HTTPException(409, "Solo puede registrarse un intento para una tarea pendiente y desbloqueada.")
        attempt_id = str(uuid4())
        connection.execute(
            """INSERT INTO task_attempts (id, task_id, task_version, task_snapshot, connector, model, status, result, started_at)
               VALUES (?, ?, ?, ?, ?, ?, 'running', '', ?)""",
            (attempt_id, str(task_id), task.version, task.model_dump_json(), safe_text(connector), safe_text(model) if model else None, now()),
        )
        connection.execute("UPDATE tasks SET status='in_progress', version=version+1, updated_at=? WHERE id=?", (now(), str(task_id)))
        activity(connection, load_task(connection, project_id, task_id), "attempt_started", attempt_id, actor="supervisor")
        return attempt_from_row(connection.execute("SELECT * FROM task_attempts WHERE id=?", (attempt_id,)).fetchone())


def finish_attempt(database: Database, project_id: UUID, task_id: UUID, attempt_id: UUID, *,
                   status: FinalAttemptStatus, result: str = "", error: str | None = None) -> Attempt:
    """Finalización atómica y única. El éxito siempre queda en revisión humana."""
    if status not in {"succeeded", "failed", "cancelled", "interrupted"} or len(result) > 64000 or (error is not None and len(error) > 4000):
        raise HTTPException(422, "Estado o tamaño de resultado no válido.")
    if (status == "succeeded" and error is not None) or (status != "succeeded" and not (error and error.strip())):
        raise HTTPException(422, "El resultado y el error no corresponden al estado del intento.")
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = load_task(connection, project_id, task_id)
        row = connection.execute("SELECT * FROM task_attempts WHERE id=? AND task_id=?", (str(attempt_id), str(task_id))).fetchone()
        if row is None:
            raise HTTPException(404, "El intento no existe en esta tarea.")
        if row["status"] != "running":
            raise HTTPException(409, "El intento ya ha terminado; sus evidencias se conservan.")
        connection.execute("UPDATE task_attempts SET status=?, result=?, error=?, finished_at=? WHERE id=?",
                           (status, safe_text(result), safe_text(error) if error else None, now(), str(attempt_id)))
        connection.execute("UPDATE tasks SET status=?, version=version+1, updated_at=? WHERE id=?",
                           ("in_review" if status == "succeeded" else "pending", now(), str(task.id)))
        activity(connection, load_task(connection, project_id, task_id), "attempt_finished", f"{attempt_id}: {status}", actor="supervisor")
        return attempt_from_row(connection.execute("SELECT * FROM task_attempts WHERE id=?", (str(attempt_id),)).fetchone())
