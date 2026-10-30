import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from konsora_api.database import MIGRATIONS
from konsora_api.main import create_app
from konsora_api.tasks import finish_attempt, start_attempt


@pytest.fixture(autouse=True)
def forbid_agent_calls(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Las operaciones de tareas no deben invocar agentes.")
    monkeypatch.setattr("konsora_api.connectors.CodexCLIConnector.send", forbidden)
    monkeypatch.setattr("konsora_api.connectors.MockConnector.send", forbidden)
    monkeypatch.setattr("konsora_api.connectors.run_cli", forbidden)


def project_tasks(client, name="Proyecto"):
    project = client.post("/projects", json={"name": name}).json()
    folder = client.app.state.database.path.parent / "workspaces" / str(uuid4())
    folder.mkdir(parents=True)
    assert client.patch(f"/projects/{project['id']}/workspace", json={"workspace_path": str(folder)}).status_code == 200
    base = f"/projects/{project['id']}/tasks"
    preview = client.get(base + "/migration").json()
    assert client.post(base + "/initialize", json={"mode": "empty", "legacy_revision": preview["legacy_revision"], "target": preview["target"], "confirm": True}).status_code == 200
    return base


def create(client, base, title="Tarea", **fields):
    response = client.post(base, json={"title": title, "expected_revision": client.get(base + "/board").json()["source"]["revision"], **fields})
    assert response.status_code == 201, response.text
    return response.json()


def edit(client, base, task, **changes):
    fields = {key: task[key] for key in ("title", "description", "acceptance_criteria", "sort_order", "dependencies")}
    return client.patch(f"{base}/{task['id']}", json={**fields, "expected_version": task["version"], "expected_revision": client.get(base + "/board").json()["source"]["revision"], **changes})


def move(client, base, task, status, **fields):
    return client.post(f"{base}/{task['id']}/status", json={"expected_version": task["version"], "status": status, "expected_revision": client.get(base + "/board").json()["source"]["revision"], **fields})


def delete(client, base, task):
    return client.delete(f"{base}/{task['id']}", params={"expected_version": task["version"], "confirm": "true", "expected_revision": client.get(base + "/board").json()["source"]["revision"]})


def begin(client, task):
    return start_attempt(client.app.state.database, UUID(task["project_id"]), UUID(task["id"]),
                         expected_version=task["version"], connector="test", model="local",
                         expected_revision=client.get(f"/projects/{task['project_id']}/tasks/board").json()["source"]["revision"])


def finish(client, task, attempt, **fields):
    return finish_attempt(client.app.state.database, UUID(task["project_id"]), UUID(task["id"]), attempt.id, **fields)


def test_crud_order_version_and_project_isolation(client):
    base, other = project_tasks(client), project_tasks(client, "Otro")
    a = create(client, base, "  Primera 🧩  ", description="Detalle", acceptance_criteria="Comprobar resultado")
    b = create(client, base, "Segunda", sort_order=0)
    assert a["title"] == "Primera 🧩" and a["version"] == 1 and a["status"] == "pending"
    assert client.get(other).json() == []
    foreign = f"{other}/{a['id']}"
    assert client.get(foreign).status_code == 404
    assert edit(client, other, a, title="Ajena").status_code == 404
    assert move(client, other, a, "in_progress").status_code == 404
    assert delete(client, other, a).status_code == 404
    updated = edit(client, base, a, title="Nueva", sort_order=10).json()
    assert updated["version"] == 2 and updated["created_at"] == a["created_at"]
    assert [t["id"] for t in client.get(base).json()] == [b["id"], a["id"]]
    assert edit(client, base, a, title="Obsoleta").status_code == 409
    assert move(client, base, a, "in_progress").status_code == 409
    assert delete(client, base, a).status_code == 409
    assert client.delete(f"{base}/{a['id']}?expected_version=2").status_code == 422
    assert delete(client, base, updated).status_code == 204
    assert client.get(f"{base}/{a['id']}").status_code == 404


def test_partial_edit_preserves_omitted_fields_and_rejects_null(client):
    base = project_tasks(client)
    dependency = create(client, base)
    task = create(client, base, description="Conservar", acceptance_criteria="Criterios", dependencies=[dependency["id"]])
    path = f"{base}/{task['id']}"
    response = client.patch(path, json={"expected_version": 1, "title": "Solo título", "expected_revision": task["source_revision"]})
    assert response.status_code == 200
    saved = response.json()
    assert saved["description"] == task["description"] and saved["acceptance_criteria"] == task["acceptance_criteria"]
    assert saved["dependencies"] == task["dependencies"]
    assert client.patch(path, json={"expected_version": saved["version"], "description": None}).status_code == 422
    assert client.get(path).json()["task"] == saved


def test_manual_transitions_require_review_and_acceptance(client):
    base = project_tasks(client)
    task = create(client, base, status="proposal")
    assert move(client, base, task, "done").status_code == 409
    assert move(client, base, task, "in_progress").status_code == 409
    for status in ("pending", "in_progress", "in_review", "done"):
        response = move(client, base, task, status, comment="Revisión humana")
        assert response.status_code == 200, response.text
        task = response.json()
    detail = client.get(f"{base}/{task['id']}").json()
    assert detail["attempts"] == []
    assert len(detail["activity"]) == 5 and all(event["actor"] == "user" for event in detail["activity"])
    reordered = edit(client, base, task, sort_order=42).json()
    assert reordered["status"] == "pending"
    edited = edit(client, base, reordered, acceptance_criteria="Nuevo alcance").json()
    assert edited["status"] == "pending"
    assert move(client, base, edited, "done").status_code == 409


def test_dependencies_cycles_cross_project_and_rollback(client):
    base, other = project_tasks(client), project_tasks(client)
    a = create(client, base, "A")
    b = create(client, base, "B", dependencies=[a["id"]])
    c = create(client, base, "C", dependencies=[b["id"]])
    foreign = create(client, other)
    assert b["blocked"] and b["blocked_by"] == [a["id"]]
    assert move(client, base, b, "in_progress").status_code == 409
    a = client.get(f"{base}/{a['id']}").json()["task"]
    for dependencies in ([a["id"]], [c["id"]], [foreign["id"]], [str(uuid4())], [b["id"], b["id"]]):
        assert edit(client, base, a, title="No guardar", dependencies=dependencies).status_code == 422
        assert client.get(f"{base}/{a['id']}").json()["task"] == a
    for status in ("in_progress", "in_review"):
        a = move(client, base, a, status).json()
    assert client.get(f"{base}/{b['id']}").json()["task"]["blocked"]
    a = move(client, base, a, "done").json()
    assert not client.get(f"{base}/{b['id']}").json()["task"]["blocked"]
    assert delete(client, base, a).status_code == 409
    assert delete(client, base, c).status_code == 204
    assert delete(client, base, b).status_code == 204
    assert delete(client, base, a).status_code == 204


@pytest.mark.parametrize("outcome", ["failed", "cancelled", "interrupted"])
def test_attempt_history_retry_and_human_acceptance(client, database_path, outcome):
    base = project_tasks(client)
    task = create(client, base, "Intentos", description="Alcance original")
    dependent = create(client, base, dependencies=[task["id"]])
    first = begin(client, task)
    active = client.get(f"{base}/{task['id']}").json()["task"]
    assert active["status"] == "in_progress" and first.task_version == task["version"]
    assert first.task_snapshot.description == "Alcance original"
    assert edit(client, base, active).status_code == 409
    assert move(client, base, active, "done").status_code == 409
    assert delete(client, base, active).status_code == 409
    assert client.delete(f"/projects/{task['project_id']}?confirm=true").status_code == 409
    with pytest.raises(HTTPException) as duplicate:
        begin(client, active)
    assert duplicate.value.status_code == 409
    completed_first = finish(client, task, first, status=outcome, result="Evidencia parcial", error="Error controlado")
    current = client.get(f"{base}/{task['id']}").json()["task"]
    assert current["status"] == "pending" and current["last_attempt_status"] == outcome
    current = edit(client, base, current, description="Alcance revisado").json()
    second = begin(client, current)
    finish(client, current, second, status="succeeded", result="Resultado para revisar")
    detail = client.get(f"{base}/{task['id']}").json()
    assert detail["task"]["status"] == "in_review"
    assert detail["attempts"][0] == completed_first.model_dump(mode="json")
    assert detail["attempts"][0]["task_snapshot"]["description"] == "Alcance original"
    assert detail["attempts"][1]["task_snapshot"]["description"] == "Alcance revisado"
    assert client.get(f"{base}/{dependent['id']}").json()["task"]["blocked"]
    assert move(client, base, detail["task"], "done").status_code == 200
    assert not client.get(f"{base}/{dependent['id']}").json()["task"]["blocked"]
    with pytest.raises(HTTPException) as overwrite:
        finish(client, task, first, status="succeeded", result="No sobrescribir")
    assert overwrite.value.status_code == 409
    saved = client.get(f"{base}/{task['id']}").json()
    with TestClient(create_app(database_path)) as restarted:
        assert restarted.get(f"{base}/{task['id']}").json() == saved


def test_file_failure_rolls_back_tasks_dependencies_activity_and_attempts(client, monkeypatch):
    base = project_tasks(client)
    a, b = create(client, base), create(client, base)
    before = client.get(f"{base}/{a['id']}").json()
    def fail(*args, **kwargs):
        raise OSError("private failure")
    with monkeypatch.context() as patch:
        patch.setattr("konsora_api.task_storage.FileStore.atomic_write", fail)
        assert edit(client, base, a, title="No guardar", dependencies=[b["id"]]).status_code == 503
        response = client.post(base, json={"title": "Rollback", "expected_revision": client.get(base + "/board").json()["source"]["revision"]})
        assert response.status_code == 503 and "private failure" not in response.text
        assert move(client, base, a, "in_progress").status_code == 503
        with pytest.raises(HTTPException) as failure:
            begin(client, a)
        assert failure.value.status_code == 503
    assert client.get(f"{base}/{a['id']}").json() == before
    assert len(client.get(base).json()) == 2
    attempt = begin(client, a)
    running = client.get(f"{base}/{a['id']}").json()
    with monkeypatch.context() as patch:
        patch.setattr("konsora_api.task_storage.FileStore.atomic_write", fail)
        with pytest.raises(HTTPException) as failure:
            finish(client, a, attempt, status="succeeded", result="No guardar")
        assert failure.value.status_code == 503
    assert client.get(f"{base}/{a['id']}").json() == running


def test_active_manual_task_and_project_cascade(client):
    base = project_tasks(client)
    task = create(client, base)
    other = create(client, base, dependencies=[task["id"]])
    task = move(client, base, task, "in_progress").json()
    assert edit(client, base, task).status_code == 409
    assert delete(client, base, task).status_code == 409
    task = move(client, base, task, "pending").json()
    assert client.delete(f"/projects/{task['project_id']}?confirm=true").status_code == 204
    assert client.get(base).status_code == 404


@pytest.mark.parametrize("fields", [
    {"title": " "}, {"title": "x" * 121}, {"sort_order": -1}, {"sort_order": True},
    {"status": "done"}, {"status": "blocked"}, {"description": "x" * 16001},
    {"api_key": "sk-fictitious_secret_task"}, {"version": 100},
])
def test_invalid_contracts_never_create_tasks_or_echo_inputs(client, fields):
    base = project_tasks(client)
    response = client.post(base, json={"title": "Tarea", **fields})
    assert response.status_code == 422 and "sk-fictitious_secret_task" not in response.text
    assert client.get(base).json() == []


def test_v4_migration_preserves_project_and_folder(database_path, tmp_path):
    database_path.parent.mkdir(parents=True)
    project_id = str(uuid4())
    timestamp = "2026-10-30T10:00:00+00:00"
    with sqlite3.connect(database_path) as connection:
        for migration in MIGRATIONS[:4]:
            for statement in migration:
                connection.execute(statement)
        connection.execute("INSERT INTO projects VALUES (?, 'Anterior', ?, ?, ?)", (project_id, timestamp, timestamp, str(tmp_path)))
        connection.execute("PRAGMA user_version=4")
    with TestClient(create_app(database_path)) as client:
        project = client.get(f"/projects/{project_id}").json()
        assert project["workspace_path"] == str(tmp_path) and project["created_at"] == timestamp.replace("+00:00", "Z")
        base = f"/projects/{project_id}/tasks"
        assert client.get(base).json() == []
        preview = client.get(base + "/migration").json()
        assert client.post(base + "/initialize", json={"mode": "empty", "legacy_revision": preview["legacy_revision"], "target": preview["target"], "confirm": True}).status_code == 200
        create(client, base)
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
