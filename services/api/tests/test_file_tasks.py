import json
import os
import shutil
import sqlite3
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from konsora_api import legacy_tasks
from konsora_api.main import create_app
from konsora_api.task_models import CreateTask


def register(client, folder, name="Archivos"):
    folder.mkdir(parents=True, exist_ok=True)
    project = client.post("/projects", json={"name": name}).json()
    assert client.patch(f"/projects/{project['id']}/workspace", json={"workspace_path": str(folder)}).status_code == 200
    return project, f"/projects/{project['id']}/tasks"


def external(folder, tasks):
    directory = folder / ".konsora"
    directory.mkdir(exist_ok=True)
    path = directory / "tasks.json"
    path.write_text(json.dumps({"schema_version": 1, "tasks": tasks}))
    return path


def test_reading_or_associating_never_initializes_and_legacy_is_read_only(client, tmp_path):
    folder = tmp_path / "project"
    project, base = register(client, folder)
    assert client.get(base + "/board").json()["source"]["mode"] == "uninitialized"
    assert list(folder.iterdir()) == []
    legacy_tasks.create_task(UUID(project["id"]), CreateTask(title="Anterior"), client.app.state.database)
    board = client.get(base + "/board").json()
    assert board["source"]["mode"] == "legacy" and not board["source"]["can_write"]
    assert client.get(f"{base}/{board['tasks'][0]['id']}").json()["read_only"]
    assert client.post(base, json={"title": "No crear"}).status_code == 428
    assert list(folder.iterdir()) == []


def test_external_files_conflicts_invalid_missing_and_atomic_replacement(client, tmp_path):
    folder = tmp_path / "project"
    _, base = register(client, folder)
    path = external(folder, [{"id": "A", "title": "Externa"}])
    first = client.get(base + "/board").json()
    revision = first["source"]["revision"]
    path.write_text(json.dumps({"schema_version": 1, "tasks": [{"id": "A", "title": "Cambiada sin subir versión"}]}))
    original = path.read_bytes()
    response = client.patch(base + "/A", json={"expected_version": 1, "expected_revision": revision, "title": "No pisar"})
    assert response.status_code == 409 and path.read_bytes() == original
    new = client.get(base + "/board").json()
    assert new["tasks"][0]["title"] == "Cambiada sin subir versión" and new["source"]["revision"] != revision
    path.write_text('{"schema_version":')
    assert client.get(base + "/board").status_code == 422
    assert path.read_text() == '{"schema_version":'
    path.unlink()
    assert client.get(base + "/board").json()["source"]["mode"] == "uninitialized"
    replacement = path.with_suffix(".tmp")
    replacement.write_bytes(original)
    replacement.replace(path)
    board = client.get(base + "/board").json()
    assert board["source"]["can_write"]
    response = client.patch(base + "/A", json={"expected_version": 1, "expected_revision": board["source"]["revision"], "title": "Desde UI"})
    assert response.status_code == 200
    assert json.loads(path.read_text())["tasks"][0]["title"] == "Desde UI"
    assert not list(path.parent.glob("*.tmp"))


def test_migration_preserves_sql_ids_attempts_and_rebuilds_without_old_database(client, database_path, tmp_path):
    folder = tmp_path / "original"
    project, base = register(client, folder)
    db = client.app.state.database
    task = legacy_tasks.create_task(UUID(project["id"]), CreateTask(title="Histórico", acceptance_criteria="Conservar todo"), db)
    attempt = legacy_tasks.start_attempt(db, UUID(project["id"]), UUID(task.id), expected_version=1, connector="qa")
    legacy_tasks.finish_attempt(db, UUID(project["id"]), UUID(task.id), UUID(attempt.id), status="failed", result="Resultado parcial", error="Cancelación de QA")
    with sqlite3.connect(database_path) as connection:
        before = {table: connection.execute(f"SELECT * FROM {table}").fetchall() for table in ("tasks", "task_attempts", "task_activity", "task_dependencies")}
    preview = client.get(base + "/migration").json()
    assert preview["task_count"] == 1 and preview["attempt_count"] == 1 and not preview["file_exists"]
    response = client.post(base + "/initialize", json={"mode": "migrate", "legacy_revision": preview["legacy_revision"], "target": preview["target"], "confirm": True})
    assert response.status_code == 200, response.text
    path = folder / ".konsora/tasks.json"
    saved = json.loads(path.read_text())
    assert saved["tasks"][0]["id"] == task.id and saved["attempts"][0]["result"] == "Resultado parcial"
    assert "project_id" not in path.read_text()
    original = path.read_bytes()
    assert client.post(base + "/initialize", json={"mode": "migrate", "legacy_revision": preview["legacy_revision"], "target": preview["target"], "confirm": True}).status_code == 409
    assert path.read_bytes() == original
    with sqlite3.connect(database_path) as connection:
        for table, rows in before.items():
            assert connection.execute(f"SELECT * FROM {table}").fetchall() == rows
    copied = tmp_path / "copied"
    shutil.copytree(folder, copied)
    with TestClient(create_app(tmp_path / "clean" / "db.sqlite3", connectors={})) as clean:
        _, other = register(clean, copied)
        detail = clean.get(f"{other}/{task.id}").json()
        assert detail["task"]["id"] == task.id and detail["attempts"][0]["result"] == "Resultado parcial"
        assert len(detail["activity"]) == len(saved["activity"])
        assert clean.delete(f"/projects/{detail['task']['project_id']}?confirm=true").status_code == 204
        assert (copied / ".konsora/tasks.json").read_bytes() == original


def test_external_done_and_forged_review_cannot_accept_dependencies(client, tmp_path, database_path):
    folder = tmp_path / "project"
    _, base = register(client, folder)
    path = external(folder, [{"id": "A", "title": "Hecha declarada", "status": "done"},
                             {"id": "B", "title": "Dependiente", "dependencies": ["A"]}])
    board = client.get(base + "/board").json()
    assert board["tasks"][0]["status"] == "in_review" and board["tasks"][0]["review_required"]
    assert board["tasks"][1]["blocked"]
    assert not (database_path.parent / "instance-review.key").exists()
    accepted = client.post(base + "/A/status", json={"status": "done", "expected_version": 1, "expected_revision": board["source"]["revision"]})
    assert accepted.status_code == 200 and accepted.json()["status"] == "done"
    assert not client.get(base).json()[1]["blocked"]
    assert (database_path.parent / "instance-review.key").stat().st_mode & 0o777 == 0o600
    data = json.loads(path.read_text())
    data["reviews"][0]["signature"] = "0" * 64
    path.write_text(json.dumps(data))
    assert client.get(base).json()[1]["blocked"]


def test_copy_or_edit_invalidates_acceptance_and_scope_revision(client, tmp_path):
    folder = tmp_path / "original"
    _, base = register(client, folder)
    path = external(folder, [{"id": "A", "title": "Revisar", "status": "done"}])
    board = client.get(base + "/board").json()
    accepted = client.post(base + "/A/status", json={"status": "done", "expected_version": 1, "expected_revision": board["source"]["revision"]}).json()
    copied = tmp_path / "copy"
    shutil.copytree(folder, copied)
    project2, other = register(client, copied)
    moved = client.get(other + "/board").json()
    assert moved["tasks"][0]["review_required"] and moved["source"]["revision"] != accepted["source_revision"]
    assert client.patch(other + "/A", json={"expected_version": accepted["version"], "expected_revision": accepted["source_revision"], "title": "No cambiar carpeta"}).status_code == 409
    data = json.loads(path.read_text()); data["tasks"][0]["title"] = "Editada sin aumentar versión"
    path.write_text(json.dumps(data))
    assert client.get(base).json()[0]["review_required"]


@pytest.mark.parametrize("kind", ["directory", "symlink", "hardlink", "fifo"])
def test_unsafe_metadata_paths_cannot_read_or_write_outside_project(client, tmp_path, kind):
    folder = tmp_path / "project"
    _, base = register(client, folder)
    outside = tmp_path / "outside"; outside.mkdir()
    sentinel = outside / "tasks.json"; sentinel.write_text('{"schema_version":1,"tasks":[]}')
    meta = folder / ".konsora"
    if kind == "directory":
        meta.symlink_to(outside, target_is_directory=True)
    else:
        meta.mkdir()
        if kind == "symlink": (meta / "tasks.json").symlink_to(sentinel)
        elif kind == "hardlink": os.link(sentinel, meta / "tasks.json")
        else: os.mkfifo(meta / "tasks.json")
    assert client.get(base + "/board").status_code == 409
    assert sentinel.read_text() == '{"schema_version":1,"tasks":[]}'


def test_initialization_rejects_changed_target_and_existing_file(client, tmp_path):
    folder = tmp_path / "one"
    project, base = register(client, folder)
    preview = client.get(base + "/migration").json()
    other = tmp_path / "two"; other.mkdir()
    client.patch(f"/projects/{project['id']}/workspace", json={"workspace_path": str(other)})
    response = client.post(base + "/initialize", json={"mode": "empty", "legacy_revision": preview["legacy_revision"], "target": preview["target"], "confirm": True})
    assert response.status_code == 409 and list(other.iterdir()) == []
