"""Contrato HTTP inicial; el arranque de desarrollo solo escucha en loopback."""

from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from konsora_api.database import Database, StorageError, default_database_path
from konsora_api.projects import router as projects_router
from konsora_api.model_routes import LOCAL_ORIGINS, router as model_router
from konsora_api.providers import ModelProvider, ProviderError, configured_providers


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["konsora-api"] = "konsora-api"


async def health() -> HealthResponse:
    return HealthResponse()


def create_app(
    database_path: Path | None = None,
    *, providers: dict[str, ModelProvider] | None = None,
) -> FastAPI:
    application = FastAPI(title="Konsora API", version="0.1.0")
    application.state.database = Database(
        database_path if database_path is not None else default_database_path()
    )
    application.state.providers = providers if providers is not None else configured_providers()
    application.add_middleware(
        CORSMiddleware,
        allow_origins=LOCAL_ORIGINS,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )

    @application.exception_handler(StorageError)
    async def storage_error_handler(request: Request, error: StorageError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.exception_handler(ProviderError)
    async def provider_error_handler(request: Request, error: ProviderError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content={"code": error.code, "detail": str(error)})

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, error: RequestValidationError) -> Response:
        if request.url.path.startswith("/providers"):
            # No reflejar prompts ni campos accidentales con secretos en errores.
            return JSONResponse(status_code=422, content={"detail": "Revisa el modelo, el prompt (1–16000 caracteres) y el límite de salida (16–2048). No se admiten campos adicionales."})
        return await request_validation_exception_handler(request, error)

    application.add_api_route("/health", health, response_model=HealthResponse)
    application.include_router(projects_router)
    application.include_router(model_router)
    return application


app = create_app()
