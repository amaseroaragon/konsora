"""K-014: contrato retirado y apertura conservadora del esquema histórico."""

import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from konsora_api.connectors import MockConnector
from konsora_api.database import MIGRATIONS
from konsora_api.main import create_app

BASE_URL = "http://127.0.0.1:8000"
TABLES = ("projects", "conversations", "messages", "debates", "proposals")


def snapshot(path):
    with sqlite3.connect(path) as connection:
        return {
            table: connection.execute(
                f"SELECT {'id, name, created_at, updated_at' if table == 'projects' else '*'} FROM {table} ORDER BY id"
            ).fetchall()
            for table in TABLES
        }


@pytest.fixture
def historical_v3(database_path):
    database_path.parent.mkdir(parents=True)
    project, chat, debate = (str(uuid4()) for _ in range(3))
    now = "2026-10-29T12:00:00+00:00"
    with sqlite3.connect(database_path) as connection:
        for migration in MIGRATIONS[:3]:
            for statement in migration:
                connection.execute(statement)
        connection.execute("INSERT INTO projects VALUES (?, 'Proyecto anterior', ?, ?)", (project, now, now))
        connection.execute(
            "INSERT INTO conversations VALUES (?, ?, 'Chat anterior', 'mock', NULL, ?, ?)",
            (chat, project, now, now),
        )
        connection.execute(
            "INSERT INTO messages VALUES (?, ?, 1, 'user', 'Mensaje anterior', 'mock', 'Simulado local', ?)",
            (str(uuid4()), chat, now),
        )
        connection.execute(
            "INSERT INTO debates VALUES (?, ?, 'Problema histórico', 'Contexto conservado', 1, ?, ?)",
            (debate, project, now, now),
        )
        for position, status, content in ((1, "completed", "Resultado histórico"), (2, "running", None)):
            connection.execute(
                "INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?)",
                (str(uuid4()), debate, position, f"Simulado {position}", f"mock-debate-{position}",
                 f"simulated-{position}", status, content, now, now,
                 now if status == "completed" else None),
            )
        connection.execute("PRAGMA user_version=3")
    return project, chat, debate


def test_v3_history_stays_intact_across_restarts(database_path, historical_v3):
    project, chat, _ = historical_v3
    before = snapshot(database_path)
    for _ in range(2):
        with TestClient(create_app(database_path, connectors={"mock": MockConnector()}), base_url=BASE_URL) as client:
            assert client.get("/projects").json()[0]["id"] == project
            assert client.get(f"/projects/{project}").json()["name"] == "Proyecto anterior"
            assert client.get(f"/projects/{project}/conversations").json()[0]["id"] == chat
            history = client.get(f"/projects/{project}/conversations/{chat}").json()
            assert history["messages"][0]["content"] == "Mensaje anterior"
            assert snapshot(database_path) == before
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
        assert connection.execute("SELECT workspace_path FROM projects").fetchone()[0] is None
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_all_retired_routes_return_404_without_touching_history(database_path, historical_v3):
    project, _, debate = historical_v3
    base = f"/projects/{project}/debates"
    before = snapshot(database_path)
    with TestClient(create_app(database_path, connectors={"mock": MockConnector()}), base_url=BASE_URL) as client:
        for method, path, body in (
            ("GET", base, None), ("POST", base, {"problem": "Nuevo"}),
            ("GET", f"{base}/{debate}", None), ("POST", f"{base}/{debate}/run", {}),
            ("POST", base, {"problem": "", "participants": ["codex", "other"]}),
        ):
            response = client.request(method, path, **({"json": body} if body is not None else {}))
            assert response.status_code == 404
        assert not any("debates" in path for path in client.get("/openapi.json").json()["paths"])
        assert not hasattr(client.app.state, "debates")
    assert snapshot(database_path) == before


def test_existing_chat_can_continue_without_changing_historical_records(database_path, historical_v3):
    project, chat, _ = historical_v3
    before = snapshot(database_path)
    with TestClient(create_app(database_path, connectors={"mock": MockConnector()}), base_url=BASE_URL) as client:
        response = client.post(
            f"/projects/{project}/conversations/{chat}/messages", json={"content": "Continuar"},
        )
        assert response.status_code == 200
        assert [item["content"] for item in response.json()["messages"]] == [
            "Mensaje anterior", "Continuar", "Respuesta simulada: Continuar",
        ]
    after = snapshot(database_path)
    assert after["debates"] == before["debates"]
    assert after["proposals"] == before["proposals"]
    assert len(after["messages"]) == 3
    with TestClient(create_app(database_path, connectors={"mock": MockConnector()}), base_url=BASE_URL) as client:
        assert len(client.get(f"/projects/{project}/conversations/{chat}").json()["messages"]) == 3


def test_confirmed_project_deletion_keeps_existing_cascade(database_path, historical_v3):
    project, _, _ = historical_v3
    before = snapshot(database_path)
    with TestClient(create_app(database_path, connectors={"mock": MockConnector()}), base_url=BASE_URL) as client:
        assert client.delete(f"/projects/{project}").status_code == 422
        assert snapshot(database_path) == before
        assert client.delete(f"/projects/{project}?confirm=true").status_code == 204
    assert all(rows == [] for rows in snapshot(database_path).values())


