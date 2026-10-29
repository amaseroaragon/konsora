"""Prueba puntual de proveedores, sin conversaciones ni persistencia de prompts."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from konsora_api.providers import Generation, ModelProvider, ProviderInfo

router = APIRouter(prefix="/providers", tags=["providers"])
LOCAL_ORIGINS = [
    "http://127.0.0.1:1420", "http://localhost:1420",
    "tauri://localhost", "http://tauri.localhost",
]


def local_request(request: Request) -> None:
    # CORS por sí solo no impide que una web envíe peticiones al backend local.
    if request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "El acceso a proveedores requiere un host local.")
    origin = request.headers.get("origin")
    if origin is not None and origin not in LOCAL_ORIGINS:
        raise HTTPException(403, "Origen no permitido para acceder a los proveedores.")
    if request.method == "POST" and request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "El envío de prompts requiere JSON.")


class GenerateRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
    prompt: str = Field(min_length=1, max_length=16000)
    max_output_tokens: int = Field(default=512, ge=16, le=2048, strict=True)


def get_providers(request: Request) -> dict[str, ModelProvider]:
    return request.app.state.providers


Providers = Annotated[dict[str, ModelProvider], Depends(get_providers)]


@router.get("", response_model=list[ProviderInfo], dependencies=[Depends(local_request)])
def list_providers(providers: Providers) -> list[ProviderInfo]:
    return [provider.info() for provider in providers.values()]


@router.post("/{provider_id}/generate", response_model=Generation, dependencies=[Depends(local_request)])
async def generate(provider_id: str, payload: GenerateRequest, providers: Providers) -> Generation:
    provider = providers.get(provider_id)
    if provider is None:
        raise HTTPException(404, "El proveedor no está disponible.")
    return await provider.generate(payload.model, payload.prompt, payload.max_output_tokens)
