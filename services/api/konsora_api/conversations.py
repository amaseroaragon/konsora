"""Chats locales: contexto por conversación y turnos confirmados de forma atómica."""

import json
import sqlite3
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from konsora_api.connector_routes import Connectors, local_request, send_while_connected
from konsora_api.connectors import safe_text, valid_model
from konsora_api.projects import LocalDatabase

router = APIRouter(
    prefix="/projects/{project_id}/conversations", tags=["conversations"],
    dependencies=[Depends(local_request)],
)
MAX_CONTEXT_CHARACTERS = 64000


class ConversationSettings(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    connector: str = Field(default="mock", min_length=1, max_length=80)
    model: str | None = Field(default=None, min_length=1, max_length=120)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str | None) -> str | None:
        if value is not None and not valid_model(value):
            raise ValueError("Modelo no válido.")
        return value


class CreateConversation(ConversationSettings):
    title: str = Field(min_length=1, max_length=120)


class SendMessage(ConversationSettings):
    content: str = Field(min_length=1, max_length=16000)
    confirm_subscription_use: bool = Field(default=False, strict=True)


class Conversation(BaseModel):
    id: UUID
    project_id: UUID
    title: str
    connector: str
    model: str | None
    created_at: datetime
    updated_at: datetime


class Message(BaseModel):
    id: UUID
    position: int
    role: Literal["user", "assistant"]
    content: str
    connector: str
    model: str
    created_at: datetime


class ConversationHistory(BaseModel):
    conversation: Conversation
    messages: list[Message]


def require_project(connection: sqlite3.Connection, project_id: UUID) -> None:
    if connection.execute("SELECT id FROM projects WHERE id = ?", (str(project_id),)).fetchone() is None:
        raise HTTPException(404, "El proyecto ya no existe.")


def history(connection: sqlite3.Connection, project_id: UUID, conversation_id: UUID) -> ConversationHistory:
    row = connection.execute(
        "SELECT * FROM conversations WHERE id = ? AND project_id = ?",
        (str(conversation_id), str(project_id)),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "La conversación no existe en este proyecto.")
    rows = connection.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC",
        (str(conversation_id),),
    ).fetchall()
    return ConversationHistory(
        conversation=Conversation.model_validate(dict(row)),
        messages=[Message.model_validate(dict(item)) for item in rows],
    )


def check_settings(payload: ConversationSettings, connectors: Connectors) -> None:
    if payload.connector not in connectors:
        raise HTTPException(404, "El conector no está disponible.")
    if payload.connector == "mock" and payload.model is not None:
        raise HTTPException(422, "El simulador solo admite su modelo local.")


@router.get("", response_model=list[Conversation])
def list_conversations(project_id: UUID, database: LocalDatabase) -> list[Conversation]:
    with database.connect() as connection:
        require_project(connection, project_id)
        rows = connection.execute(
            "SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC, id ASC",
            (str(project_id),),
        ).fetchall()
    return [Conversation.model_validate(dict(row)) for row in rows]


@router.post("", response_model=Conversation, status_code=201)
def create_conversation(
    project_id: UUID, payload: CreateConversation, database: LocalDatabase, connectors: Connectors,
) -> Conversation:
    check_settings(payload, connectors)
    now = datetime.now(UTC)
    conversation = Conversation(
        id=uuid4(), project_id=project_id, title=safe_text(payload.title),
        connector=payload.connector, model=payload.model, created_at=now, updated_at=now,
    )
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        require_project(connection, project_id)
        connection.execute(
            """INSERT INTO conversations
               (id, project_id, title, connector, model, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (str(conversation.id), str(project_id), conversation.title, conversation.connector,
             conversation.model, now.isoformat(), now.isoformat()),
        )
    return conversation


@router.get("/{conversation_id}", response_model=ConversationHistory)
def open_conversation(
    project_id: UUID, conversation_id: UUID, database: LocalDatabase,
) -> ConversationHistory:
    with database.connect() as connection:
        connection.execute("BEGIN")
        return history(connection, project_id, conversation_id)


@router.post("/{conversation_id}/messages", response_model=ConversationHistory)
async def send_message(
    project_id: UUID, conversation_id: UUID, payload: SendMessage,
    database: LocalDatabase, connectors: Connectors, request: Request,
) -> ConversationHistory:
    check_settings(payload, connectors)
    if payload.connector != "mock" and not payload.confirm_subscription_use:
        raise HTTPException(409, "Confirma el uso de cuota para enviar este mensaje y el historial del chat.")
    active: set[UUID] = request.app.state.active_conversations
    if conversation_id in active:
        raise HTTPException(409, "Este chat ya está esperando una respuesta.")
    active.add(conversation_id)
    try:
        with database.connect() as connection:
            connection.execute("BEGIN")
            previous = history(connection, project_id, conversation_id)
        content = safe_text(payload.content)
        transcript = [{"role": item.role, "content": item.content} for item in previous.messages]
        transcript.append({"role": "user", "content": content})
        prompt = json.dumps({
            "konsora_conversation": 1,
            "instruction": "Continúa esta conversación respondiendo al último mensaje del usuario. Solo texto, sin herramientas.",
            "messages": transcript,
        }, ensure_ascii=False)
        if len(prompt) > MAX_CONTEXT_CHARACTERS:
            raise HTTPException(422, "El chat supera el límite de contexto de 64000 caracteres. Abre un nuevo chat; el historial se conserva completo.")
        result = await send_while_connected(
            connectors[payload.connector], prompt, request, model=payload.model,
        )
        # Sin transacciones abiertas mientras responde el CLI. Se comprueba de
        # nuevo el chat y su posición por si otro proceso escribió o lo eliminó.
        with database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = history(connection, project_id, conversation_id)
            if len(current.messages) != len(previous.messages):
                raise HTTPException(409, "El historial cambió durante la consulta. Ábrelo de nuevo antes de enviar.")
            now = datetime.now(UTC).isoformat()
            for offset, role, text in ((1, "user", content), (2, "assistant", safe_text(result.text))):
                connection.execute(
                    """INSERT INTO messages
                       (id, conversation_id, position, role, content, connector, model, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (str(uuid4()), str(conversation_id), len(previous.messages) + offset,
                     role, text, payload.connector, safe_text(result.model), now),
                )
            connection.execute(
                "UPDATE conversations SET connector = ?, model = ?, updated_at = ? WHERE id = ?",
                (payload.connector, payload.model, now, str(conversation_id)),
            )
            connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, str(project_id)))
            return history(connection, project_id, conversation_id)
    finally:
        active.discard(conversation_id)
