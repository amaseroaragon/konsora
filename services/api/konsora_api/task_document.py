"""Contrato portable independiente de SQLite, procesos y proveedores."""

import hashlib
import json
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
TaskState = Literal["proposal", "pending", "in_progress", "in_review", "done"]
AttemptState = Literal["running", "succeeded", "failed", "cancelled", "interrupted"]


class DocumentError(ValueError):
    """Error público sin reflejar contenido del archivo."""


class PortableTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=ID_PATTERN)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=16000)
    acceptance_criteria: str = Field(default="", max_length=16000)
    sort_order: int = Field(default=0, ge=0, le=2147483647, strict=True)
    status: TaskState = "pending"
    version: int = Field(default=1, ge=1, strict=True)
    dependencies: list[str] = Field(default_factory=list, max_length=200)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @model_validator(mode="after")
    def validate_task(self):
        if not self.title.strip() or len(set(self.dependencies)) != len(self.dependencies):
            raise ValueError("Título vacío o dependencias repetidas.")
        for timestamp in (self.created_at, self.updated_at):
            if timestamp is not None and timestamp.tzinfo is None:
                raise ValueError("Las fechas deben incluir zona horaria.")
        return self


class PortableAttempt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=ID_PATTERN)
    task_id: str = Field(pattern=ID_PATTERN)
    task_version: int = Field(ge=1, strict=True)
    task_snapshot: PortableTask
    connector: str = Field(min_length=1, max_length=80)
    model: str | None = Field(default=None, max_length=120)
    status: AttemptState
    result: str = Field(default="", max_length=64000)
    error: str | None = Field(default=None, max_length=4000)
    started_at: datetime
    finished_at: datetime | None = None

    @model_validator(mode="after")
    def validate_attempt(self):
        if self.task_snapshot.id != self.task_id or self.task_snapshot.version != self.task_version:
            raise ValueError("Instantánea de intento incoherente.")
        if self.status == "running":
            valid = self.finished_at is None and self.error is None
        elif self.status == "succeeded":
            valid = self.finished_at is not None and self.error is None
        else:
            valid = self.finished_at is not None and bool(self.error and self.error.strip())
        if not valid or self.started_at.tzinfo is None or (self.finished_at is not None and (
            self.finished_at.tzinfo is None or self.finished_at < self.started_at
        )):
            raise ValueError("Estado o fechas del intento incoherentes.")
        return self


class PortableActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int = Field(ge=1, strict=True)
    task_id: str = Field(pattern=ID_PATTERN)
    task_version: int = Field(ge=1, strict=True)
    event: str = Field(min_length=1, max_length=80)
    actor: Literal["user", "supervisor", "external"]
    detail: str = Field(default="", max_length=4000)
    created_at: datetime


class PortableReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str = Field(pattern=ID_PATTERN)
    fingerprint: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    accepted_at: datetime
    signature: str = Field(pattern=r"^[0-9a-f]{64}$")


class TaskDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1]
    tasks: list[PortableTask] = Field(max_length=2000)
    attempts: list[PortableAttempt] = Field(default_factory=list, max_length=20000)
    activity: list[PortableActivity] = Field(default_factory=list, max_length=50000)
    reviews: list[PortableReview] = Field(default_factory=list, max_length=10000)

    @field_validator("schema_version", mode="before")
    @classmethod
    def strict_schema(cls, value):
        if type(value) is not int:
            raise ValueError("La versión debe ser un entero.")
        return value

    @model_validator(mode="after")
    def validate_document(self):
        by_id = {task.id: task for task in self.tasks}
        if len(by_id) != len(self.tasks):
            raise ValueError("IDs de tarea duplicados.")
        for task in self.tasks:
            if task.id in task.dependencies or any(dep not in by_id for dep in task.dependencies):
                raise ValueError("Dependencia inexistente o autodependencia.")
        # Kahn evita límites de recursión con archivos largos generados externamente.
        remaining = {task.id: len(task.dependencies) for task in self.tasks}
        dependents: dict[str, list[str]] = {}
        for task in self.tasks:
            for dependency in task.dependencies:
                dependents.setdefault(dependency, []).append(task.id)
        ready = [key for key, count in remaining.items() if count == 0]
        visited = 0
        while ready:
            visited += 1
            for child in dependents.get(ready.pop(), []):
                remaining[child] -= 1
                if remaining[child] == 0:
                    ready.append(child)
        if visited != len(self.tasks):
            raise ValueError("Ciclo de dependencias.")
        for collection in (self.attempts, self.activity, self.reviews):
            if any(item.task_id not in by_id for item in collection):
                raise ValueError("Historial de una tarea inexistente.")
        if len({item.id for item in self.attempts}) != len(self.attempts) or len({item.id for item in self.activity}) != len(self.activity):
            raise ValueError("IDs de historial duplicados.")
        running = [item.task_id for item in self.attempts if item.status == "running"]
        if len(running) != len(set(running)):
            raise ValueError("Más de un intento activo por tarea.")
        return self


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def task_fingerprint(task: PortableTask) -> str:
    return digest(json.dumps(task.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DocumentError("El JSON contiene claves repetidas.")
        result[key] = value
    return result


def parse_document(data: bytes) -> TaskDocument:
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentError("El archivo de tareas supera 8 MiB.")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return TaskDocument.model_validate(value)
    except (UnicodeError, ValueError, ValidationError, RecursionError) as error:
        raise DocumentError("Archivo de tareas inválido: revisa el esquema v1, IDs, dependencias, estados y límites. Se conserva el archivo original.") from error


def serialize_document(document: TaskDocument) -> bytes:
    data = (json.dumps(document.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n").encode()
    parse_document(data)
    return data
