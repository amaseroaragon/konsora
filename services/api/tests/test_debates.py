import asyncio
import json
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from konsora_api.connectors import CodexCLIConnector, ConnectorError, MockConnector, PromptResult
from konsora_api.database import MIGRATIONS
from konsora_api.debate_simulators import DebateSimulator
from konsora_api.main import create_app

BASE_URL = "http://127.0.0.1:8000"
SECRET = "sk-fictitious_debate_test_credential"


@pytest.fixture(autouse=True)
def forbid_real_connectors(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Un debate simulado no debe consultar ni ejecutar un CLI real.")
    for method in ("info", "models", "send"):
        monkeypatch.setattr(CodexCLIConnector, method, forbidden)
    monkeypatch.setattr("konsora_api.connectors.run_cli", forbidden)


class RecordingSimulator(DebateSimulator):
    def __init__(self, position, *, fail=False, delay=0):
        super().__init__(position, delay=delay)
        self.calls = []
        self.fail = fail

    async def send(self, prompt, *, model=None):
        self.calls.append(prompt)
        if self.fail:
            raise ConnectorError(502, "simulated_failure", SECRET)
        await asyncio.sleep(self.delay)
        return PromptResult(connector=self.id, model=self.model, text=f"Propuesta exclusiva {self.letter}")


@pytest.fixture
def debate_client(database_path):
    first, second = RecordingSimulator(1), RecordingSimulator(2)
    app = create_app(database_path, connectors={"mock": MockConnector()}, debate_participants=(first, second))
    with TestClient(app, base_url=BASE_URL) as client:
        yield client, first, second


def make_debate(client, *, project=None, problem="Problema de prueba", context="Contexto autorizado"):
    if project is None:
        project = client.post("/projects", json={"name": "Proyecto de debate"}).json()
    base = f"/projects/{project['id']}/debates"
    response = client.post(base, json={"problem": problem, "context": context})
    assert response.status_code == 201, response.text
    saved = response.json()
    return project, saved, f"{base}/{saved['debate']['id']}"


def run(client, path, body=None):
    return client.post(path + "/run", json=body if body is not None else {})


def test_independent_identical_context_and_separate_identities(debate_client):
    client, first, second = debate_client
    project, pending, path = make_debate(client, problem="  ¿Cómo empezar? 🧩  ", context=" Datos seleccionados ")
    _, _, sibling = make_debate(client, project=project, problem="PRIVADO_OTRO_DEBATE")
    other_project, _, other = make_debate(client, problem="PRIVADO_OTRO_PROYECTO")
    chat = client.post(f"/projects/{project['id']}/conversations", json={"title": "Privado"}).json()
    client.post(f"/projects/{project['id']}/conversations/{chat['id']}/messages", json={"content": "PRIVADO_CHAT"})
    assert first.calls == second.calls == []
    assert [p["status"] for p in pending["proposals"]] == ["pending", "pending"]
    response = run(client, path)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert len(first.calls) == len(second.calls) == 1
    assert first.calls[0] == second.calls[0]
    prompt = json.loads(first.calls[0])
    assert prompt["problem"] == "¿Cómo empezar? 🧩"
    assert prompt["context"] == "Datos seleccionados"
    assert "PRIVADO" not in first.calls[0]
    assert "Propuesta exclusiva" not in first.calls[0]
    assert set(prompt) == {"konsora_debate", "instruction", "problem", "context"}
    assert [p["name"] for p in saved["proposals"]] == ["Simulado A", "Simulado B"]
    assert [p["connector"] for p in saved["proposals"]] == ["mock-debate-a", "mock-debate-b"]
    assert [p["model"] for p in saved["proposals"]] == ["simulated-a", "simulated-b"]
    assert [p["position"] for p in saved["proposals"]] == [1, 2]
    assert len({p["id"] for p in saved["proposals"]}) == 2
    for proposal in saved["proposals"]:
        assert proposal["status"] == "completed" and proposal["simulated"] is True
        assert proposal["created_at"] <= proposal["started_at"] <= proposal["finished_at"]
        assert proposal["error"] is None
    assert client.get(path).json() == saved
    assert client.get(sibling).json()["proposals"][0]["status"] == "pending"
    assert client.get(other).json()["proposals"][0]["status"] == "pending"
    assert len(client.get(f"/projects/{project['id']}/debates").json()) == 2
    foreign = f"/projects/{other_project['id']}/debates/{pending['debate']['id']}"
    assert client.get(foreign).status_code == 404
    assert run(client, foreign).status_code == 404
    assert run(client, path).status_code == 409
    assert len(first.calls) == len(second.calls) == 1


def test_default_simulators_are_local_and_distinct(database_path):
    async def exercise():
        from konsora_api.debates import initial_prompt
        a, b = DebateSimulator(1, delay=0), DebateSimulator(2, delay=0)
        prompt = initial_prompt("Una idea", "Contexto")
        first, second = await asyncio.gather(a.send(prompt), b.send(prompt))
        assert first.text != second.text
        assert "Propuesta simulada A" in first.text
        assert "Propuesta simulada B" in second.text
        assert "no una respuesta de IA" in first.text
        assert (await a.info()).status == "simulated"
        assert await b.models() == []
    asyncio.run(exercise())
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        _, _, path = make_debate(client)
        assert run(client, path).status_code == 200


@pytest.mark.parametrize("failed", [1, 2, "both"])
def test_partial_failure_preserves_success_without_raw_diagnostics(debate_client, failed):
    client, first, second = debate_client
    first.fail = failed in (1, "both")
    second.fail = failed in (2, "both")
    _, _, path = make_debate(client)
    response = run(client, path)
    assert response.status_code == 200
    assert SECRET not in response.text
    saved = response.json()
    for position, proposal in enumerate(saved["proposals"], 1):
        expected_failure = failed in (position, "both")
        assert proposal["status"] == ("failed" if expected_failure else "completed")
        assert bool(proposal["error"]) == expected_failure
        assert (proposal["content"] is None) == expected_failure
    assert client.get(path).json() == saved
    assert run(client, path).status_code == 409
    assert len(first.calls) == len(second.calls) == 1


def test_timeout_and_invalid_results_are_individual(debate_client):
    client, first, second = debate_client
    second.delay = 1
    client.app.state.debates.timeout = 0.02
    _, _, path = make_debate(client)
    proposals = run(client, path).json()["proposals"]
    assert [p["status"] for p in proposals] == ["completed", "failed"]
    assert "tiempo" in proposals[1]["error"]


@pytest.mark.parametrize("invalid", ["identity", "empty", "oversized"])
def test_unexpected_identity_and_output_are_rejected(debate_client, invalid):
    client, _, second = debate_client
    async def bad(prompt):
        return PromptResult(connector="claude" if invalid == "identity" else second.id,
                            model=second.model, text=" " if invalid == "empty" else "x" * 24001 if invalid == "oversized" else "Falso")
    second.send = bad
    _, _, path = make_debate(client)
    saved = run(client, path).json()
    assert [p["status"] for p in saved["proposals"]] == ["completed", "failed"]
    assert saved["proposals"][1]["connector"] == "mock-debate-b"
    assert saved["proposals"][1]["content"] is None


def test_restarts_preserve_snapshot_and_completed_proposals(debate_client, database_path):
    client, _, _ = debate_client
    project, pending, path = make_debate(client)
    saved = run(client, path).json()
    with TestClient(create_app(database_path), base_url=BASE_URL) as restarted:
        assert restarted.get(path).json() == saved
        assert restarted.get(f"/projects/{project['id']}/debates").json() == [saved["debate"]]
        assert run(restarted, path).status_code == 409


def test_completion_order_does_not_change_participant_order(debate_client):
    client, first, _ = debate_client
    first.delay = 0.03
    _, _, path = make_debate(client)
    proposals = run(client, path).json()["proposals"]
    assert [p["position"] for p in proposals] == [1, 2]
    assert proposals[1]["finished_at"] < proposals[0]["finished_at"]
    assert [p["content"] for p in proposals] == ["Propuesta exclusiva A", "Propuesta exclusiva B"]


def test_disconnect_before_any_result_cancels_both(debate_client):
    client, first, second = debate_client
    first.delay = second.delay = 2
    project, pending, _ = make_debate(client)
    async def disconnected():
        return {"type": "http.disconnect"}
    request = Request({"type": "http", "app": client.app}, disconnected)
    project_id, debate_id = UUID(project["id"]), UUID(pending["debate"]["id"])
    with pytest.raises(HTTPException) as cancelled:
        asyncio.run(client.app.state.debates.run(project_id, debate_id, request))
    assert cancelled.value.status_code == 499
    saved = client.app.state.debates.get(project_id, debate_id)
    assert [p.status for p in saved.proposals] == ["cancelled", "cancelled"]
    assert all(p.content is None and p.finished_at for p in saved.proposals)


def test_restart_recovers_interrupted_participant_without_overwriting_completed(debate_client, database_path):
    client, _, _ = debate_client
    _, _, path = make_debate(client)
    saved = run(client, path).json()
    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE proposals SET status='running', content=NULL, error=NULL, finished_at=NULL WHERE id=?", (saved["proposals"][1]["id"],))
    with TestClient(create_app(database_path), base_url=BASE_URL) as restarted:
        recovered = restarted.get(path).json()
        assert recovered["proposals"][0] == saved["proposals"][0]
        assert recovered["proposals"][1]["status"] == "cancelled"
        assert "reiniciar" in recovered["proposals"][1]["error"]
        assert recovered["debate"]["problem"] == saved["debate"]["problem"]
        assert recovered["debate"]["context"] == saved["debate"]["context"]
        assert restarted.get(path).json() == recovered


@pytest.mark.parametrize("cancel_mode", ["disconnect", "task"])
def test_partial_completion_concurrent_start_and_cancellation(debate_client, cancel_mode):
    client, first, second = debate_client
    project, pending, path = make_debate(client)
    service = client.app.state.debates

    async def exercise():
        disconnect = asyncio.Event()
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def waiting(prompt):
            second.calls.append(prompt)
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        second.send = waiting
        async def receive():
            await disconnect.wait()
            return {"type": "http.disconnect"}
        request = Request({"type": "http", "app": client.app}, receive)
        project_id, debate_id = UUID(project["id"]), UUID(pending["debate"]["id"])
        task = asyncio.create_task(service.run(project_id, debate_id, request))
        await asyncio.wait_for(started.wait(), 2)
        for _ in range(100):
            snapshot = service.get(project_id, debate_id)
            if snapshot.proposals[0].status == "completed":
                break
            await asyncio.sleep(0.01)
        assert snapshot.proposals[0].status == "completed"
        with pytest.raises(HTTPException) as busy:
            await service.run(project_id, debate_id, request)
        assert busy.value.status_code == 409
        if cancel_mode == "disconnect":
            disconnect.set()
            with pytest.raises(HTTPException) as cancelled:
                await task
            assert cancelled.value.status_code == 499
        else:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert stopped.is_set()
        final = service.get(project_id, debate_id)
        assert final.proposals[0] == snapshot.proposals[0]
        assert final.proposals[1].status == "cancelled"
        assert final.proposals[1].finished_at is not None
        assert len(first.calls) == len(second.calls) == 1
    asyncio.run(exercise())


def test_project_deleted_during_generation_is_not_recreated(debate_client):
    client, first, _ = debate_client
    project, pending, path = make_debate(client)
    async def deleting(prompt):
        with client.app.state.database.connect() as connection:
            connection.execute("DELETE FROM projects WHERE id=?", (project["id"],))
        return PromptResult(connector=first.id, model=first.model, text="Tarde")
    first.send = deleting
    assert run(client, path).status_code == 404
    assert client.get("/projects").json() == []
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT count(*) FROM debates").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM proposals").fetchone()[0] == 0


def test_v2_migration_preserves_chats_and_projects(database_path):
    database_path.parent.mkdir(parents=True)
    project, chat, message = (str(uuid4()) for _ in range(3))
    now = "2026-10-29T12:00:00+00:00"
    with sqlite3.connect(database_path) as connection:
        for migration in MIGRATIONS[:2]:
            for statement in migration:
                connection.execute(statement)
        connection.execute("INSERT INTO projects VALUES (?, 'Existente', ?, ?)", (project, now, now))
        connection.execute("INSERT INTO conversations VALUES (?, ?, 'Chat existente', 'mock', NULL, ?, ?)", (chat, project, now, now))
        connection.execute("INSERT INTO messages VALUES (?, ?, 1, 'user', 'Conservar mensaje', 'mock', 'Simulado local', ?)", (message, chat, now))
        connection.execute("PRAGMA user_version=2")
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        assert client.get(f"/projects/{project}/debates").json() == []
        history = client.get(f"/projects/{project}/conversations/{chat}").json()
        assert history["messages"][0]["content"] == "Conservar mensaje"
        make_debate(client, project={"id": project})
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_create_rollback_and_completed_result_survives_write_failure(debate_client, database_path):
    client, first, second = debate_client
    project = client.post("/projects", json={"name": "Conservar"}).json()
    base = f"/projects/{project['id']}/debates"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TRIGGER reject_second BEFORE INSERT ON proposals WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT, 'private write error'); END")
    assert client.post(base, json={"problem": "No guardar"}).status_code == 503
    assert client.get(base).json() == []
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TRIGGER reject_second")
    _, _, path = make_debate(client, project=project)
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TRIGGER reject_result BEFORE UPDATE ON proposals WHEN NEW.position=2 AND NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'private write error'); END")
    response = run(client, path)
    assert response.status_code == 503
    assert "private write error" not in response.text
    saved = client.get(path).json()
    assert [p["status"] for p in saved["proposals"]] == ["completed", "cancelled"]
    assert saved["proposals"][0]["content"] == "Propuesta exclusiva A"


def test_locked_storage_never_invokes_participants_and_recovers(debate_client, database_path):
    client, first, second = debate_client
    _, pending, path = make_debate(client)
    client.app.state.database.timeout = 0.01
    with sqlite3.connect(database_path) as lock:
        lock.execute("BEGIN EXCLUSIVE")
        assert run(client, path).status_code == 503
    assert client.get(path).json() == pending
    assert first.calls == second.calls == []
    assert run(client, path).status_code == 200


@pytest.mark.parametrize("payload", [
    {"problem": " "}, {"problem": None}, {"problem": "x" * 16001},
    {"problem": "Hola", "context": "x" * 32001},
    {"problem": "Hola", "connector": "codex"}, {"problem": "Hola", "simulated": False},
    {"problem": "Hola", "api_key": SECRET}, {"problem": "Hola", "participants": ["codex", "claude"]},
    {"problem": "\\" * 16000, "context": "\\" * 32000},
])
def test_input_validation_and_no_real_mode(debate_client, payload):
    client, first, second = debate_client
    project = client.post("/projects", json={"name": "Validación"}).json()
    base = f"/projects/{project['id']}/debates"
    response = client.post(base, json=payload)
    assert response.status_code == 422
    assert SECRET not in response.text
    assert client.get(base).json() == []
    assert first.calls == second.calls == []


def test_missing_and_invalid_ids_and_extra_run_fields(debate_client):
    client, first, second = debate_client
    project, _, path = make_debate(client)
    base = f"/projects/{project['id']}/debates"
    assert client.get(f"/projects/{uuid4()}/debates").status_code == 404
    assert client.post(f"/projects/{uuid4()}/debates", json={"problem": "Hola"}).status_code == 404
    assert client.get(f"{base}/{uuid4()}").status_code == 404
    assert client.get(base + "/invalid").status_code == 422
    assert run(client, path, {"connector": "codex"}).status_code == 422
    assert first.calls == second.calls == []


def test_redaction_before_storage_and_prompts(debate_client, database_path):
    client, first, _ = debate_client
    _, _, path = make_debate(client, problem=f"Revisar {SECRET}", context=f"Bearer fictitious-token")
    async def reflected(prompt):
        first.calls.append(prompt)
        return PromptResult(connector=first.id, model=first.model, text=SECRET)
    first.send = reflected
    response = run(client, path)
    assert response.status_code == 200
    assert SECRET not in response.text
    assert SECRET not in first.calls[0]
    assert "Bearer fictitious-token" not in first.calls[0]
    assert SECRET.encode() not in database_path.read_bytes()


@pytest.mark.parametrize("origin", ["https://foreign.invalid", "null", "http://localhost:9999"])
def test_foreign_origin_cannot_create_read_or_run(debate_client, origin):
    client, first, second = debate_client
    _, _, path = make_debate(client)
    headers = {"Origin": origin}
    assert client.get(path, headers=headers).status_code == 403
    assert client.post(path + "/run", json={}, headers=headers).status_code == 403
    assert first.calls == second.calls == []


def test_host_content_type_and_local_origin(debate_client):
    client, _, _ = debate_client
    _, _, path = make_debate(client)
    assert client.get(path, headers={"Host": "foreign.invalid"}).status_code == 403
    assert client.post(path + "/run", data={"prompt": "Hola"}).status_code == 415
    response = client.get(path, headers={"Origin": "http://127.0.0.1:1420"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:1420"


def test_confirmed_project_delete_cascades_debates_and_proposals(debate_client):
    client, _, _ = debate_client
    project, _, path = make_debate(client)
    run(client, path)
    assert client.delete(f"/projects/{project['id']}").status_code == 422
    assert client.get(path).status_code == 200
    assert client.delete(f"/projects/{project['id']}?confirm=true").status_code == 204
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT count(*) FROM debates").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM proposals").fetchone()[0] == 0
