import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from konsora_api.database import MIGRATIONS, Database, StorageError, default_database_path
from konsora_api.main import create_app


def test_project_lifecycle_and_isolation(client: TestClient) -> None:
    assert client.get("/projects").json() == []
    response = client.post("/projects", json={"name": "  Primer proyecto  "})
    assert response.status_code == 201
    first = response.json()
    assert first["name"] == "Primer proyecto"
    assert first["created_at"] == first["updated_at"]

    second = client.post("/projects", json={"name": "Otro proyecto"}).json()
    assert first["id"] != second["id"]
    assert [p["id"] for p in client.get("/projects").json()] == [second["id"], first["id"]]
    assert client.get(f"/projects/{first['id']}").json() == first

    response = client.patch(f"/projects/{first['id']}", json={"name": "Nuevo nombre"})
    assert response.status_code == 200
    renamed = response.json()
    assert renamed["name"] == "Nuevo nombre"
    assert renamed["id"] == first["id"]
    assert renamed["created_at"] == first["created_at"]
    assert renamed["updated_at"] >= first["updated_at"]
    assert client.get(f"/projects/{second['id']}").json() == second

    assert client.delete(f"/projects/{first['id']}?confirm=true").status_code == 204
    assert client.get(f"/projects/{first['id']}").status_code == 404
    assert client.get("/projects").json() == [second]


def test_persistence_after_recreating_application(database_path: Path) -> None:
    with TestClient(create_app(database_path)) as first_client:
        project = first_client.post("/projects", json={"name": "Persistente"}).json()
        project = first_client.patch(
            f"/projects/{project['id']}", json={"name": "Nombre guardado"}
        ).json()

    with TestClient(create_app(database_path)) as second_client:
        assert second_client.get("/projects").json() == [project]
        assert second_client.get(f"/projects/{project['id']}").json() == project
        assert second_client.delete(f"/projects/{project['id']}?confirm=true").status_code == 204

    with TestClient(create_app(database_path)) as third_client:
        assert third_client.get("/projects").json() == []


@pytest.mark.parametrize("confirmation", ["", "?confirm=false"])
def test_delete_requires_explicit_confirmation(client: TestClient, confirmation: str) -> None:
    project = client.post("/projects", json={"name": "Conservar"}).json()
    assert client.delete(f"/projects/{project['id']}{confirmation}").status_code == 422
    assert client.get(f"/projects/{project['id']}").json() == project


@pytest.mark.parametrize("name", ["", "   ", "\n\t", "a" * 121, None, 123])
def test_invalid_names_never_modify_projects(client: TestClient, name: object) -> None:
    project = client.post("/projects", json={"name": "Original"}).json()
    assert client.post("/projects", json={"name": name}).status_code == 422
    assert client.patch(f"/projects/{project['id']}", json={"name": name}).status_code == 422
    assert client.get("/projects").json() == [project]


def test_names_are_bound_parameters(client: TestClient) -> None:
    name = "Diseño 🧩'); DROP TABLE projects;--"
    response = client.post("/projects", json={"name": name})
    assert response.status_code == 201
    assert client.get("/projects").json()[0]["name"] == name


@pytest.mark.parametrize("method", ["get", "patch", "delete"])
def test_missing_projects(client: TestClient, method: str) -> None:
    kwargs = {"json": {"name": "Cambio"}} if method == "patch" else {}
    response = client.request(method, f"/projects/{uuid4()}?confirm=true", **kwargs)
    assert response.status_code == 404
    assert response.json() == {"detail": "El proyecto ya no existe."}


def test_invalid_id_is_rejected(client: TestClient) -> None:
    assert client.get("/projects/not-a-uuid").status_code == 422


def test_write_failure_rolls_back_and_can_be_retried(client: TestClient, database_path: Path) -> None:
    project = client.post("/projects", json={"name": "Conservar"}).json()
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """CREATE TRIGGER reject_rename AFTER UPDATE ON projects
               BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END"""
        )
    response = client.patch(f"/projects/{project['id']}", json={"name": "No guardar"})
    assert response.status_code == 503
    assert "simulated" not in response.text
    assert client.get(f"/projects/{project['id']}").json() == project

    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TRIGGER reject_rename")
    assert client.patch(f"/projects/{project['id']}", json={"name": "Recuperado"}).status_code == 200


def test_locked_database_preserves_data(client: TestClient, database_path: Path) -> None:
    project = client.post("/projects", json={"name": "Intacto"}).json()
    client.app.state.database.timeout = 0.01
    with sqlite3.connect(database_path) as lock:
        lock.execute("BEGIN EXCLUSIVE")
        assert client.get("/projects").status_code == 503
        assert client.post("/projects", json={"name": "Bloqueado"}).status_code == 503
        assert client.delete(f"/projects/{project['id']}?confirm=true").status_code == 503
    assert client.get("/projects").json() == [project]


def test_corrupt_database_is_not_replaced(database_path: Path) -> None:
    database_path.parent.mkdir()
    original = b"Archivo no SQLite: no reconstruir ni sobrescribir."
    database_path.write_bytes(original)
    with TestClient(create_app(database_path)) as client:
        assert client.get("/projects").status_code == 503
        assert client.post("/projects", json={"name": "No crear"}).status_code == 503
        assert client.get("/health").status_code == 200
    assert database_path.read_bytes() == original


def test_unavailable_path_returns_error_without_replacing_it(database_path: Path) -> None:
    database_path.mkdir(parents=True)
    with TestClient(create_app(database_path)) as client:
        assert client.get("/projects").status_code == 503
        assert str(database_path) not in client.get("/projects").text
    assert database_path.is_dir()


def test_newer_schema_is_not_downgraded(client: TestClient, database_path: Path) -> None:
    project = client.post("/projects", json={"name": "Versión futura"}).json()
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA user_version = 99")
    assert client.get("/projects").status_code == 503
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 99
        assert connection.execute("SELECT name FROM projects").fetchone()[0] == project["name"]


def test_migration_is_idempotent_and_transactional(
    client: TestClient, database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = client.post("/projects", json={"name": "Conservar en la migración"}).json()
    database = Database(database_path)
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
    with database.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)

    # La segunda sentencia falla después de cambiar el esquema: ambas se revierten.
    from konsora_api import database as database_module

    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        (*database_module.MIGRATIONS, ("CREATE TABLE pending (id TEXT)", "INVALID SQL")),
    )
    with pytest.raises(StorageError):
        with database.connect():
            pass
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
        assert connection.execute("SELECT name FROM sqlite_master WHERE name = 'pending'").fetchone() is None
        assert connection.execute("SELECT id, name FROM projects").fetchone() == (
            project["id"], project["name"]
        )


def test_relative_database_path_is_anchored_to_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    from konsora_api.database import REPOSITORY_ROOT

    monkeypatch.setenv("KONSORA_DATABASE_PATH", ".local/custom.sqlite3")
    assert default_database_path() == REPOSITORY_ROOT / ".local/custom.sqlite3"


@pytest.mark.parametrize("method", ["POST", "PATCH", "DELETE"])
def test_cors_preflight_for_project_writes(client: TestClient, method: str) -> None:
    response = client.options(
        "/projects",
        headers={
            "Origin": "http://127.0.0.1:1420",
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:1420"
