"""Contrato HTTP inicial; el arranque de desarrollo solo escucha en loopback."""

from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Konsora API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "tauri://localhost",
        "http://tauri.localhost",
    ],
    allow_methods=["GET"],
    allow_headers=[],
    allow_credentials=False,
)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["konsora-api"] = "konsora-api"


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse()
