"""Consulta de texto puntual, sin dar acceso a proyectos ni persistir conversaciones."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from konsora_api.connectors import AgentConnector, ConnectorInfo, PromptResult

router = APIRouter(prefix="/connectors", tags=["connectors"])
LOCAL_ORIGINS = [
    "http://127.0.0.1:1420", "http://localhost:1420",
    "tauri://localhost", "http://tauri.localhost",
]


def local_request(request: Request) -> None:
    if request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "Se requiere un host local para acceder a los conectores.")
    origin = request.headers.get("origin")
    if origin is not None and origin not in LOCAL_ORIGINS:
        raise HTTPException(403, "Origen no permitido para acceder a los conectores.")
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if request.method == "POST" and content_type != "application/json":
        raise HTTPException(415, "El envío de prompts requiere JSON.")


class PromptRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    prompt: str = Field(min_length=1, max_length=16000)
    confirm_subscription_use: bool = Field(default=False, strict=True)


def get_connectors(request: Request) -> dict[str, AgentConnector]:
    return request.app.state.connectors


Connectors = Annotated[dict[str, AgentConnector], Depends(get_connectors)]


async def send_while_connected(
    connector: AgentConnector, prompt: str, request: Request, *, model: str | None = None,
) -> PromptResult:
    async def wait_for_disconnect() -> None:
        # El cuerpo ya lo ha leído FastAPI. Esperar el evento ASGI evita sondeos
        # y permite cancelar la espera sin los CancelScope de is_disconnected().
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return

    sending = asyncio.create_task(connector.send(prompt, model=model) if model is not None else connector.send(prompt))
    disconnect = asyncio.create_task(wait_for_disconnect())
    try:
        done, _ = await asyncio.wait({sending, disconnect}, return_when=asyncio.FIRST_COMPLETED)
        if sending in done:
            return sending.result()
        raise HTTPException(499, "Se ha cancelado la consulta.")
    finally:
        sending.cancel()
        disconnect.cancel()
        await asyncio.gather(sending, disconnect, return_exceptions=True)


@router.get("", response_model=list[ConnectorInfo], dependencies=[Depends(local_request)])
async def list_connectors(connectors: Connectors) -> list[ConnectorInfo]:
    return list(await asyncio.gather(*(connector.info() for connector in connectors.values())))


@router.post("/{connector_id}/prompt", response_model=PromptResult, dependencies=[Depends(local_request)])
async def send_prompt(
    connector_id: str, payload: PromptRequest, connectors: Connectors, request: Request,
) -> PromptResult:
    connector = connectors.get(connector_id)
    if connector is None:
        raise HTTPException(404, "El conector no está disponible.")
    if connector_id != "mock" and not payload.confirm_subscription_use:
        raise HTTPException(409, "Confirma que quieres utilizar la cuota de tu suscripción para este prompt.")
    return await send_while_connected(connector, payload.prompt, request)
