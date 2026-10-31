"""Contrato HTTP inicial; el arranque de desarrollo solo escucha en loopback."""

from pathlib import Path
import secrets
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from konsora_api.database import Database, StorageError, default_database_path
from konsora_api.projects import router as projects_router
from konsora_api.tasks import router as tasks_router
from konsora_api.security import LocalSecurityMiddleware, development_origin


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["konsora-api"] = "konsora-api"


async def health() -> HealthResponse:
    return HealthResponse()


def create_app(database_path: Path | None = None, *, instance_token: str | None = None,
               instance_port: int = 8000, web_origin: str | None = None) -> FastAPI:
    application = FastAPI(title="Konsora API", version="0.1.0")
    application.state.database = Database(
        database_path if database_path is not None else default_database_path()
    )
    token = instance_token if instance_token is not None else secrets.token_hex(32)
    if len(token) < 32 or not token.isascii() or not 1 <= instance_port <= 65535:
        raise ValueError("Configuración local no válida.")
    application.state.instance_token = token
    origins = development_origin(web_origin)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
        allow_credentials=False,
    )
    application.add_middleware(LocalSecurityMiddleware, token=token, port=instance_port, origins=origins)

    @application.exception_handler(StorageError)
    async def storage_error_handler(request: Request, error: StorageError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, error: RequestValidationError) -> Response:
        if "/tasks/prompt/" in request.url.path:
            return JSONResponse(status_code=422, content={
                "detail": "Revisa selección sin duplicados, revisión del archivo, contexto (hasta 16000), huella del prompt y nombre de salida .md. No se admiten otros campos.",
            })
        if "/tasks" in request.url.path:
            return JSONResponse(status_code=422, content={
                "detail": "Revisa título (1–120), descripción y criterios (hasta 16000), orden, dependencias y versión vigente. No se admiten otros campos.",
            })
        return await request_validation_exception_handler(request, error)

    application.add_api_route("/health", health, response_model=HealthResponse)
    application.include_router(projects_router)
    application.include_router(tasks_router)
    return application


app = create_app()
