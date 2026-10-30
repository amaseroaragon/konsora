"""Contratos HTTP compartidos con la consulta de datos anteriores."""

from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator

TaskStatus = Literal["proposal", "pending", "in_progress", "in_review", "done"]
AttemptStatus = Literal["running", "succeeded", "failed", "cancelled", "interrupted"]
FinalAttemptStatus = Literal["succeeded", "failed", "cancelled", "interrupted"]
TRANSITIONS: dict[str, set[str]] = {
    "proposal": {"pending"}, "pending": {"in_progress"},
    "in_progress": {"in_review", "pending"}, "in_review": {"done", "pending"},
    "done": {"pending"},
}


class TaskFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=16000)
    acceptance_criteria: str = Field(default="", max_length=16000)
    sort_order: int | None = Field(default=None, ge=0, le=2147483647, strict=True)
    dependencies: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("dependencies")
    @classmethod
    def unique_dependencies(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("Las dependencias no pueden repetirse.")
        return value


class CreateTask(TaskFields):
    expected_revision: str | None = None
    status: Literal["proposal", "pending"] = "pending"


class EditTask(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    expected_version: int = Field(ge=1, strict=True)
    expected_revision: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=16000)
    acceptance_criteria: str | None = Field(default=None, max_length=16000)
    sort_order: int | None = Field(default=None, ge=0, le=2147483647, strict=True)
    dependencies: list[str] | None = Field(default=None, max_length=200)

    @field_validator("title", "description", "acceptance_criteria", "sort_order", "dependencies")
    @classmethod
    def disallow_null(cls, value):
        if value is None:
            raise ValueError("Omite el campo para conservar su valor; no se admite null.")
        if isinstance(value, list) and len(value) != len(set(value)):
            raise ValueError("Las dependencias no pueden repetirse.")
        return value


class ChangeTaskStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    expected_version: int = Field(ge=1, strict=True)
    expected_revision: str | None = None
    status: TaskStatus
    comment: str = Field(default="", max_length=4000)


class Task(BaseModel):
    id: str
    project_id: UUID
    title: str
    description: str
    acceptance_criteria: str
    sort_order: int
    status: TaskStatus
    version: int
    created_at: datetime
    updated_at: datetime
    dependencies: list[str]
    blocked_by: list[str]
    blocked: bool
    last_attempt_status: AttemptStatus | None = None
    last_attempt_error: str | None = None
    source_revision: str | None = None
    fingerprint: str | None = None
    declared_status: TaskStatus | None = None
    review_required: bool = False


class Attempt(BaseModel):
    id: str
    task_id: str
    task_version: int
    task_snapshot: Task
    connector: str
    model: str | None
    status: AttemptStatus
    result: str
    error: str | None
    started_at: datetime
    finished_at: datetime | None


class Activity(BaseModel):
    id: int
    task_id: str
    task_version: int
    event: str
    actor: Literal["user", "supervisor", "external"]
    detail: str
    created_at: datetime


class TaskDetails(BaseModel):
    task: Task
    attempts: list[Attempt]
    activity: list[Activity]
    read_only: bool = False

