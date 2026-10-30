"""Contrato y operaciones de proyectos; cada escritura es una transacción."""

import sqlite3
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from konsora_api.database import Database
from konsora_api.workspaces import WorkspaceError, WorkspaceStatus, canonical_workspace, workspace_status
from konsora_api.task_storage import FileStore

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectName(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=120)


class Project(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime
    workspace_path: str | None = None
    workspace_status: WorkspaceStatus = "unassigned"


class ProjectWorkspace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workspace_path: str | None = Field(min_length=1, max_length=4096)


def project_from_row(row: sqlite3.Row) -> Project:
    project = Project.model_validate(dict(row))
    project.workspace_status = workspace_status(project.workspace_path)
    return project


def get_database(request: Request) -> Database:
    return request.app.state.database


LocalDatabase = Annotated[Database, Depends(get_database)]


def require_project(connection: sqlite3.Connection, project_id: UUID) -> None:
    if connection.execute("SELECT id FROM projects WHERE id=?", (str(project_id),)).fetchone() is None:
        raise HTTPException(404, "El proyecto ya no existe.")


@router.get("", response_model=list[Project])
def list_projects(database: LocalDatabase) -> list[Project]:
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT * FROM projects ORDER BY created_at DESC, id ASC"
        ).fetchall()
    return [project_from_row(row) for row in rows]


@router.post("", response_model=Project, status_code=201)
def create_project(payload: ProjectName, database: LocalDatabase) -> Project:
    now = datetime.now(UTC)
    project = Project(id=uuid4(), name=payload.name, created_at=now, updated_at=now)
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (str(project.id), project.name, now.isoformat(), now.isoformat()),
        )
    return project


@router.get("/{project_id}", response_model=Project)
def open_project(project_id: UUID, database: LocalDatabase) -> Project:
    with database.connect() as connection:
        row = connection.execute(
            "SELECT * FROM projects WHERE id = ?", (str(project_id),)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="El proyecto ya no existe.")
    return project_from_row(row)


@router.patch("/{project_id}", response_model=Project)
def rename_project(project_id: UUID, payload: ProjectName, database: LocalDatabase) -> Project:
    with database.connect() as connection:
        cursor = connection.execute(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
            (payload.name, datetime.now(UTC).isoformat(), str(project_id)),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="El proyecto ya no existe.")
        row = connection.execute(
            "SELECT * FROM projects WHERE id = ?", (str(project_id),)
        ).fetchone()
    return project_from_row(row)


@router.patch("/{project_id}/workspace", response_model=Project)
def set_workspace(project_id: UUID, payload: ProjectWorkspace, database: LocalDatabase) -> Project:
    try:
        path = str(canonical_workspace(payload.workspace_path)) if payload.workspace_path is not None else None
    except WorkspaceError as error:
        raise HTTPException(422, str(error)) from error
    with database.connect() as connection:
        cursor = connection.execute(
            "UPDATE projects SET workspace_path = ?, updated_at = ? WHERE id = ?",
            (path, datetime.now(UTC).isoformat(), str(project_id)),
        )
        if cursor.rowcount == 0:
            raise HTTPException(404, "El proyecto ya no existe.")
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (str(project_id),)).fetchone()
    return project_from_row(row)


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: UUID,
    database: LocalDatabase,
    confirm: Annotated[Literal["true"], Query()],
) -> Response:
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT workspace_path FROM projects WHERE id=?", (str(project_id),)).fetchone()
        if row is not None and row[0]:
            try:
                document, _ = FileStore(row[0], database.path.parent / "instance-review.key").read()
            except HTTPException:
                # Desvincular datos locales no elimina ni repara archivos inválidos.
                document = None
            if document is not None and (any(task.status == "in_progress" for task in document.tasks) or
                    any(attempt.status == "running" for attempt in document.attempts)):
                raise HTTPException(409, "El proyecto contiene tareas activas. Detén el trabajo antes de eliminarlo.")
        if connection.execute(
            """SELECT 1 FROM tasks t WHERE project_id=? AND (status='in_progress' OR EXISTS
               (SELECT 1 FROM task_attempts a WHERE a.task_id=t.id AND a.status='running')) LIMIT 1""",
            (str(project_id),),
        ).fetchone():
            raise HTTPException(409, "El proyecto contiene tareas activas. Detén el trabajo antes de eliminarlo.")
        cursor = connection.execute("DELETE FROM projects WHERE id = ?", (str(project_id),))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="El proyecto ya no existe.")
    return Response(status_code=204)
