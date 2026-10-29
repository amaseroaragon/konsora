"""Contrato HTTP inicial; el arranque de desarrollo solo escucha en loopback."""

from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from konsora_api.database import Database, StorageError, default_database_path
from konsora_api.projects import router as projects_router


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["konsora-api"] = "konsora-api"


async def health() -> HealthResponse:
    return HealthResponse()


def create_app(database_path: Path | None = None) -> FastAPI:
    application = FastAPI(title="Konsora API", version="0.1.0")
    application.state.database = Database(
        database_path if database_path is not None else default_database_path()
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "tauri://localhost",
            "http://tauri.localhost",
        ],
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )

    @application.exception_handler(StorageError)
    async def storage_error_handler(request: Request, error: StorageError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    application.add_api_route("/health", health, response_model=HealthResponse)
    application.include_router(projects_router)
    return application


app = create_app()
