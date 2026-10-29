"""Contrato y operaciones de proyectos; cada escritura es una transacción."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from konsora_api.database import Database

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectName(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=120)


class Project(BaseModel):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime


def get_database(request: Request) -> Database:
    return request.app.state.database


LocalDatabase = Annotated[Database, Depends(get_database)]


@router.get("", response_model=list[Project])
def list_projects(database: LocalDatabase) -> list[Project]:
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT * FROM projects ORDER BY created_at DESC, id ASC"
        ).fetchall()
    return [Project.model_validate(dict(row)) for row in rows]


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
    return Project.model_validate(dict(row))


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
    return Project.model_validate(dict(row))


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: UUID,
    database: LocalDatabase,
    confirm: Annotated[Literal["true"], Query()],
) -> Response:
    with database.connect() as connection:
        cursor = connection.execute("DELETE FROM projects WHERE id = ?", (str(project_id),))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="El proyecto ya no existe.")
    return Response(status_code=204)
