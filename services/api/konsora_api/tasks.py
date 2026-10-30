"""Fachada del contrato de tareas: archivos como fuente, legado solo consultable."""

from konsora_api.task_models import (Task, TaskDetails, CreateTask, EditTask, ChangeTaskStatus, Attempt, Activity)
from konsora_api.file_tasks import (router, list_tasks, create_task, open_task, edit_task, change_status, delete_task, start_attempt, finish_attempt)
from konsora_api.task_prompts import router as prompt_router

router.include_router(prompt_router)
