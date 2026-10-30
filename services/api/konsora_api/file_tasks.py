"""API de tareas en archivos; SQLite solo localiza carpetas y conserva el legado."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict

from konsora_api import legacy_tasks as legacy
from konsora_api.connectors import safe_text
from konsora_api.database import Database
from konsora_api.projects import LocalDatabase
from konsora_api.task_document import (
    PortableActivity, PortableAttempt, PortableTask, TaskDocument, digest, serialize_document, task_fingerprint,
)
from konsora_api.task_models import (
    TRANSITIONS, Activity, Attempt, ChangeTaskStatus, CreateTask, EditTask, FinalAttemptStatus, Task, TaskDetails,
)
from konsora_api.task_storage import FileStore

router = APIRouter(prefix="/projects/{project_id}/tasks", tags=["tasks"])
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def timestamp() -> datetime:
    return datetime.now(UTC)


def project_store(database: Database, project_id: UUID) -> FileStore | None:
    with database.connect() as connection:
        row = connection.execute("SELECT workspace_path FROM projects WHERE id=?", (str(project_id),)).fetchone()
    if row is None:
        raise HTTPException(404, "El proyecto ya no existe.")
    return FileStore(row[0], database.path.parent / "instance-review.key") if row[0] else None


def require_store(database: Database, project_id: UUID) -> FileStore:
    store = project_store(database, project_id)
    if store is None:
        raise HTTPException(409, "Asocia una carpeta y migra o inicializa su archivo de tareas. Los datos anteriores son de solo lectura.")
    return store


def require_document(store: FileStore) -> tuple[TaskDocument, str]:
    document, revision = store.read()
    if document is None or revision is None:
        raise HTTPException(409, "Falta tasks.json. Inicializa o migra las tareas explícitamente.")
    return document, revision


def find(document: TaskDocument, task_id: str) -> PortableTask:
    task = next((item for item in document.tasks if item.id == str(task_id)), None)
    if task is None:
        raise HTTPException(404, "La tarea no existe en este proyecto.")
    return task


def task_view(store: FileStore, document: TaskDocument, project_id: UUID, task: PortableTask, revision: str | None) -> Task:
    unaccepted = task.status == "done" and not store.accepted(task, document)
    by_id = {item.id: item for item in document.tasks}
    blocked_by = [key for key in task.dependencies if not store.accepted(by_id[key], document)]
    attempts = [item for item in document.attempts if item.task_id == task.id]
    return Task(**task.model_dump(exclude={"created_at", "updated_at", "status"}), project_id=project_id,
                created_at=task.created_at or EPOCH, updated_at=task.updated_at or task.created_at or EPOCH,
                status="in_review" if unaccepted else task.status, declared_status=task.status,
                blocked_by=blocked_by, blocked=bool(blocked_by), review_required=unaccepted,
                source_revision=revision, fingerprint=task_fingerprint(task),
                last_attempt_status=attempts[-1].status if attempts else None,
                last_attempt_error=attempts[-1].error if attempts else None)


def attempt_view(attempt: PortableAttempt, project_id: UUID) -> Attempt:
    snapshot = attempt.task_snapshot
    return Attempt(**attempt.model_dump(exclude={"task_snapshot"}), task_snapshot=Task(
        **snapshot.model_dump(exclude={"created_at", "updated_at"}), project_id=project_id,
        created_at=snapshot.created_at or EPOCH, updated_at=snapshot.updated_at or snapshot.created_at or EPOCH,
        blocked=False, blocked_by=[], fingerprint=task_fingerprint(snapshot),
    ))


def add_activity(document: TaskDocument, task: PortableTask, event: str, detail: str = "", *, actor: str = "user"):
    document.activity.append(PortableActivity(id=max((item.id for item in document.activity), default=0) + 1,
        task_id=task.id, task_version=task.version, event=event, actor=actor,
        detail=safe_text(detail)[:4000], created_at=timestamp()))


def check_editable(document: TaskDocument, task: PortableTask, expected_version: int, *, editing: bool = False):
    if task.version != expected_version:
        raise HTTPException(409, "La tarea ha cambiado. Actualízala antes de guardar.")
    if any(item.task_id == task.id and item.status == "running" for item in document.attempts):
        raise HTTPException(409, "La tarea tiene un intento activo.")
    if editing and task.status == "in_progress":
        raise HTTPException(409, "Devuelve la tarea a pendiente antes de editar o borrar su alcance.")


class Source(BaseModel):
    mode: Literal["files", "legacy", "uninitialized", "unassigned"]
    revision: str | None
    can_write: bool
    file_path: str | None
    legacy_count: int


class Board(BaseModel):
    source: Source
    tasks: list[Task]


@router.get("/board", response_model=Board)
def board(project_id: UUID, database: LocalDatabase) -> Board:
    store = project_store(database, project_id)
    with database.connect() as connection:
        count = connection.execute("SELECT count(*) FROM tasks WHERE project_id=?", (str(project_id),)).fetchone()[0]
    document, revision = store.read() if store else (None, None)
    if document is not None and store is not None:
        tasks = [task_view(store, document, project_id, task, revision) for task in sorted(document.tasks,
            key=lambda item: (item.sort_order, item.created_at or EPOCH, item.id))]
        mode = "files"
    else:
        tasks = legacy.list_tasks(project_id, database)
        mode = "legacy" if tasks else "uninitialized" if store else "unassigned"
    return Board(source=Source(mode=mode, revision=revision, can_write=mode == "files",
        file_path=str(store.workspace / ".konsora/tasks.json") if store else None, legacy_count=count), tasks=tasks)


@router.get("", response_model=list[Task])
def list_tasks(project_id: UUID, database: LocalDatabase) -> list[Task]:
    return board(project_id, database).tasks


def legacy_document(database: Database, project_id: UUID) -> TaskDocument:
    with database.connect() as connection:
        connection.execute("BEGIN")
        rows = connection.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY sort_order, created_at, id", (str(project_id),)).fetchall()
        tasks, attempts, activity = [], [], []
        for row in rows:
            task = legacy.load_task(connection, project_id, UUID(row["id"]))
            fields = task.model_dump(mode="json", include=set(PortableTask.model_fields))
            tasks.append(PortableTask.model_validate(fields))
            for item in connection.execute("SELECT * FROM task_attempts WHERE task_id=? ORDER BY rowid", (row["id"],)):
                attempt = legacy.attempt_from_row(item)
                data = attempt.model_dump(mode="json")
                data["task_snapshot"] = attempt.task_snapshot.model_dump(mode="json", include=set(PortableTask.model_fields))
                attempts.append(PortableAttempt.model_validate(data))
            activity.extend(PortableActivity.model_validate(dict(item)) for item in connection.execute(
                "SELECT * FROM task_activity WHERE task_id=? ORDER BY id", (row["id"],)))
    return TaskDocument(schema_version=1, tasks=tasks, attempts=attempts, activity=sorted(activity, key=lambda item: item.id))


class MigrationPreview(BaseModel):
    target: str
    legacy_revision: str
    task_count: int
    attempt_count: int
    activity_count: int
    file_exists: bool


@router.get("/migration", response_model=MigrationPreview)
def migration_preview(project_id: UUID, database: LocalDatabase) -> MigrationPreview:
    store = require_store(database, project_id)
    document = legacy_document(database, project_id)
    existing, _ = store.read()
    return MigrationPreview(target=str(store.workspace / ".konsora/tasks.json"),
        legacy_revision=digest(serialize_document(document)), task_count=len(document.tasks),
        attempt_count=len(document.attempts), activity_count=len(document.activity), file_exists=existing is not None)


class Initialize(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["empty", "migrate"]
    legacy_revision: str
    target: str
    confirm: Literal[True]


@router.post("/initialize", response_model=Board)
def initialize(project_id: UUID, payload: Initialize, database: LocalDatabase) -> Board:
    store = require_store(database, project_id)
    if payload.target != str(store.workspace / ".konsora/tasks.json"):
        raise HTTPException(409, "La carpeta de destino ha cambiado. Vuelve a revisar la inicialización.")
    previous = legacy_document(database, project_id)
    if digest(serialize_document(previous)) != payload.legacy_revision:
        raise HTTPException(409, "Los datos anteriores han cambiado. Vuelve a revisar la migración.")
    if payload.mode == "empty" and previous.tasks:
        raise HTTPException(409, "Hay tareas anteriores: utiliza la migración para conservarlas.")
    with store.write(None, initialize=True) as document:
        document.tasks = previous.tasks
        document.attempts = previous.attempts
        document.activity = previous.activity
    return board(project_id, database)


@router.post("", response_model=Task, status_code=201)
def create_task(project_id: UUID, payload: CreateTask, database: LocalDatabase) -> Task:
    store = require_store(database, project_id)
    with store.write(payload.expected_revision) as document:
        task = PortableTask(id=str(uuid4()), title=safe_text(payload.title), description=safe_text(payload.description),
            acceptance_criteria=safe_text(payload.acceptance_criteria), dependencies=payload.dependencies,
            sort_order=payload.sort_order if payload.sort_order is not None else min(2147483647, max((item.sort_order for item in document.tasks), default=-1) + 1),
            status=payload.status, created_at=timestamp(), updated_at=timestamp())
        document.tasks.append(task)
        add_activity(document, task, "created")
    return task_view(store, document, project_id, task, store.revision(serialize_document(document)))


@router.get("/{task_id}", response_model=TaskDetails)
def open_task(project_id: UUID, task_id: str, database: LocalDatabase) -> TaskDetails:
    store = project_store(database, project_id)
    document, revision = store.read() if store else (None, None)
    if document is None:
        try:
            detail = legacy.open_task(project_id, UUID(task_id), database)
        except ValueError as error:
            raise HTTPException(404, "La tarea no existe en este proyecto.") from error
        detail.read_only = True
        return detail
    task = find(document, task_id)
    return TaskDetails(task=task_view(store, document, project_id, task, revision),
        attempts=[attempt_view(item, project_id) for item in document.attempts if item.task_id == task.id],
        activity=[Activity.model_validate(item.model_dump()) for item in sorted(document.activity, key=lambda event: event.id) if item.task_id == task.id])


@router.patch("/{task_id}", response_model=Task)
def edit_task(project_id: UUID, task_id: str, payload: EditTask, database: LocalDatabase) -> Task:
    store = require_store(database, project_id)
    with store.write(payload.expected_revision) as document:
        task = find(document, task_id)
        check_editable(document, task, payload.expected_version, editing=True)
        changes = payload.model_dump(exclude_unset=True, exclude={"expected_version", "expected_revision"})
        for key in ("title", "description", "acceptance_criteria"):
            if key in changes:
                changes[key] = safe_text(changes[key])
        if task.status in {"done", "in_review"} and changes:
            changes["status"] = "pending"
        updated = task.model_copy(update={**changes, "version": task.version + 1, "updated_at": timestamp()})
        document.tasks[document.tasks.index(task)] = updated
        add_activity(document, updated, "updated")
    return task_view(store, document, project_id, updated, store.revision(serialize_document(document)))


@router.post("/{task_id}/status", response_model=Task)
def change_status(project_id: UUID, task_id: str, payload: ChangeTaskStatus, database: LocalDatabase) -> Task:
    store = require_store(database, project_id)
    with store.write(payload.expected_revision) as document:
        task = find(document, task_id)
        check_editable(document, task, payload.expected_version)
        view = task_view(store, document, project_id, task, payload.expected_revision)
        if payload.status not in TRANSITIONS[view.status]:
            raise HTTPException(409, "Cambio de estado no permitido. Revisa el resultado antes de aceptarlo.")
        if view.blocked and payload.status in {"in_progress", "in_review", "done"}:
            raise HTTPException(409, "La tarea tiene dependencias sin aceptar.")
        updated = task.model_copy(update={"status": payload.status, "version": task.version + 1, "updated_at": timestamp()})
        document.tasks[document.tasks.index(task)] = updated
        add_activity(document, updated, "status_changed", f"{view.status} → {updated.status}\n{payload.comment}")
        if updated.status == "done":
            store.sign(updated, document, timestamp().isoformat())
    return task_view(store, document, project_id, updated, store.revision(serialize_document(document)))


@router.delete("/{task_id}", status_code=204)
def delete_task(project_id: UUID, task_id: str, database: LocalDatabase,
                expected_version: Annotated[int, Query(ge=1)], confirm: Annotated[Literal["true"], Query()],
                expected_revision: str | None = None) -> Response:
    store = require_store(database, project_id)
    with store.write(expected_revision) as document:
        task = find(document, task_id)
        check_editable(document, task, expected_version, editing=True)
        if any(task.id in other.dependencies for other in document.tasks):
            raise HTTPException(409, "Otras tareas dependen de esta. Retira esas dependencias antes de borrarla.")
        document.tasks.remove(task)
        document.attempts = [item for item in document.attempts if item.task_id != task.id]
        document.activity = [item for item in document.activity if item.task_id != task.id]
        document.reviews = [item for item in document.reviews if item.task_id != task.id]
    return Response(status_code=204)


def start_attempt(database: Database, project_id: UUID, task_id: str, *, expected_version: int,
                  connector: str, model: str | None = None, expected_revision: str | None = None) -> Attempt:
    """Solo registra un intento; no expuesto en HTTP ni ejecuta procesos."""
    store = require_store(database, project_id)
    with store.write(expected_revision) as document:
        task = find(document, str(task_id))
        check_editable(document, task, expected_version)
        if task_view(store, document, project_id, task, expected_revision).blocked or task.status != "pending":
            raise HTTPException(409, "La tarea debe estar pendiente y desbloqueada.")
        attempt = PortableAttempt(id=str(uuid4()), task_id=task.id, task_version=task.version,
            task_snapshot=task.model_copy(deep=True), connector=safe_text(connector), model=model, status="running", started_at=timestamp())
        document.attempts.append(attempt)
        task.status = "in_progress"; task.version += 1; task.updated_at = timestamp()
        add_activity(document, task, "attempt_started", attempt.id, actor="supervisor")
    return attempt_view(attempt, project_id)


def finish_attempt(database: Database, project_id: UUID, task_id: str, attempt_id: str, *,
                   status: FinalAttemptStatus, result: str = "", error: str | None = None) -> Attempt:
    store = require_store(database, project_id)
    _, revision = require_document(store)
    with store.write(revision) as document:
        task = find(document, str(task_id))
        attempt = next((item for item in document.attempts if item.id == str(attempt_id) and item.task_id == task.id), None)
        if attempt is None:
            raise HTTPException(404, "El intento no existe en esta tarea.")
        if attempt.status != "running":
            raise HTTPException(409, "El intento ya ha terminado. Sus evidencias se conservan.")
        attempt.status = status; attempt.result = safe_text(result); attempt.error = safe_text(error) if error is not None else None
        attempt.finished_at = timestamp()
        task.status = "in_review" if status == "succeeded" else "pending"
        task.version += 1; task.updated_at = timestamp()
        add_activity(document, task, "attempt_finished", f"{attempt.id}: {status}", actor="supervisor")
    return attempt_view(attempt, project_id)
