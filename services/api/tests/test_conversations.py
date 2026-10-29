import asyncio
import json
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from konsora_api.connectors import ConnectorError, ConnectorInfo, MockConnector, PromptResult
from konsora_api.conversations import SendMessage, send_message
from konsora_api.database import MIGRATIONS, Database
from konsora_api.main import create_app

BASE_URL = "http://127.0.0.1:8000"


class RecordingConnector:
    def __init__(self):
        self.calls = []
        self.failure = False

    async def info(self):
        return ConnectorInfo(id="codex", name="Codex de prueba", status="ready", model="default", detail="Local")

    async def send(self, prompt, *, model=None):
        self.calls.append((json.loads(prompt), model))
        if self.failure:
            raise ConnectorError(502, "network", "No se pudo conectar.")
        return PromptResult(connector="codex", model=model or "default", text="Respuesta de prueba")


@pytest.fixture
def chat_client(database_path):
    connector = RecordingConnector()
    with TestClient(create_app(database_path, connectors={"mock": MockConnector(), "codex": connector}), base_url=BASE_URL) as client:
        yield client, connector


def make_chat(client, name="Proyecto", title="Chat", **settings):
    project = client.post("/projects", json={"name": name}).json()
    base = f"/projects/{project['id']}/conversations"
    chat = client.post(base, json={"title": title, **settings})
    assert chat.status_code == 201
    return project, chat.json(), f"{base}/{chat.json()['id']}"


def send(client, path, content="Hola", **settings):
    return client.post(path + "/messages", json={"content": content, **settings})


def test_history_context_order_and_project_chat_isolation(chat_client):
    client, recorder = chat_client
    project, chat, path = make_chat(client, title="  Ideas 🧩  ")
    other_project, other_chat, other_path = make_chat(client, name="Otro")
    sibling = client.post(f"/projects/{project['id']}/conversations", json={"title": "Privado"}).json()
    assert chat["title"] == "Ideas 🧩"
    assert client.get(path).json()["messages"] == []
    assert send(client, other_path, "SECRETO_OTRO_PROYECTO").status_code == 200
    sibling_path = f"/projects/{project['id']}/conversations/{sibling['id']}"
    assert send(client, sibling_path, "SECRETO_OTRO_CHAT").status_code == 200
    assert send(client, path, "Primero", connector="codex", model="account-model", confirm_subscription_use=True).status_code == 200
    response = send(client, path, "Segundo", connector="codex", confirm_subscription_use=True)
    assert response.status_code == 200
    saved = response.json()
    assert [m["position"] for m in saved["messages"]] == [1, 2, 3, 4]
    assert [m["role"] for m in saved["messages"]] == ["user", "assistant", "user", "assistant"]
    assert [m["content"] for m in saved["messages"]] == ["Primero", "Respuesta de prueba", "Segundo", "Respuesta de prueba"]
    assert saved["messages"][1]["model"] == "account-model"
    assert saved["messages"][3]["model"] == "default"
    assert recorder.calls[0][1] == "account-model"
    assert recorder.calls[1][0]["messages"] == [
        {"role": "user", "content": "Primero"},
        {"role": "assistant", "content": "Respuesta de prueba"},
        {"role": "user", "content": "Segundo"},
    ]
    assert "SECRETO" not in json.dumps(recorder.calls)
    foreign = f"/projects/{other_project['id']}/conversations/{chat['id']}"
    assert client.get(foreign).status_code == 404
    assert send(client, foreign).status_code == 404
    assert client.get(f"/projects/{other_project['id']}/conversations").json() == [client.get(other_path).json()["conversation"]]
    assert client.get(path).json() == saved


def test_restart_preserves_model_and_history_and_continues(database_path):
    first_connector = RecordingConnector()
    with TestClient(create_app(database_path, connectors={"codex": first_connector}), base_url=BASE_URL) as first:
        _, _, path = make_chat(first, connector="codex", model="account-model")
        saved = send(first, path, connector="codex", model="account-model", confirm_subscription_use=True).json()
    second_connector = RecordingConnector()
    with TestClient(create_app(database_path, connectors={"codex": second_connector}), base_url=BASE_URL) as second:
        assert second.get(path).json() == saved
        assert saved["conversation"]["model"] == "account-model"
        assert send(second, path, "Continúa", connector="codex", model="account-model", confirm_subscription_use=True).status_code == 200
        assert len(second_connector.calls[0][0]["messages"]) == 3


def test_existing_projects_migrate_without_loss(database_path):
    database_path.parent.mkdir(parents=True)
    project_id = str(uuid4())
    with sqlite3.connect(database_path) as connection:
        for statement in MIGRATIONS[0]:
            connection.execute(statement)
        connection.execute("PRAGMA user_version = 1")
        connection.execute("INSERT INTO projects VALUES (?, ?, ?, ?)", (project_id, "Existente", "2026-10-28T12:00:00+00:00", "2026-10-28T12:00:00+00:00"))
    with TestClient(create_app(database_path, connectors={"mock": MockConnector()}), base_url=BASE_URL) as client:
        assert client.get(f"/projects/{project_id}").json()["name"] == "Existente"
        assert client.get(f"/projects/{project_id}/conversations").json() == []
        assert client.post(f"/projects/{project_id}/conversations", json={"title": "Nuevo"}).status_code == 201
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_failed_cli_preserves_previous_turn_and_releases_chat(chat_client):
    client, recorder = chat_client
    _, _, path = make_chat(client)
    saved = send(client, path).json()
    recorder.failure = True
    assert send(client, path, connector="codex", confirm_subscription_use=True).status_code == 502
    assert client.get(path).json() == saved
    assert client.app.state.active_conversations == set()
    recorder.failure = False
    assert send(client, path, connector="codex", confirm_subscription_use=True).status_code == 200


def test_failed_write_rolls_back_entire_turn(chat_client, database_path):
    client, _ = chat_client
    _, _, path = make_chat(client)
    saved = send(client, path).json()
    with sqlite3.connect(database_path) as connection:
        connection.execute("""CREATE TRIGGER reject_answer BEFORE INSERT ON messages
            WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END""")
    response = send(client, path, "No guardar")
    assert response.status_code == 503
    assert "private diagnostic" not in response.text
    assert client.get(path).json() == saved
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TRIGGER reject_answer")
    assert send(client, path, "Recuperado").status_code == 200


def test_project_delete_requires_confirmation_and_cascades_only_its_chats(chat_client, database_path):
    client, _ = chat_client
    project, _, path = make_chat(client)
    _, _, other_path = make_chat(client)
    send(client, path)
    other = send(client, other_path).json()
    assert client.delete(f"/projects/{project['id']}").status_code == 422
    assert len(client.get(path).json()["messages"]) == 2
    assert client.delete(f"/projects/{project['id']}?confirm=true").status_code == 204
    assert client.get(path).status_code == 404
    assert send(client, path).status_code == 404
    assert client.get(other_path).json() == other
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT count(*) FROM messages").fetchone()[0] == 2


@pytest.mark.parametrize("fields", [
    {"content": " "}, {"content": "x" * 16001}, {"content": None},
    {"content": "Hola", "model": "--dangerously-bypass-approvals-and-sandbox"},
    {"content": "Hola", "model": "sk-fictitious_test_credential"},
    {"content": "Hola", "model": "model;cmd"}, {"content": "Hola", "model": ""},
    {"content": "Hola", "confirm_subscription_use": "true"},
    {"content": "Hola", "command": "sk-fictitious_test_credential"},
])
def test_message_validation_never_reflects_input(chat_client, fields):
    client, recorder = chat_client
    _, _, path = make_chat(client)
    response = client.post(path + "/messages", json=fields)
    assert response.status_code == 422
    assert "sk-fictitious" not in response.text
    assert "input" not in response.json()
    assert recorder.calls == []
    assert client.get(path).json()["messages"] == []


@pytest.mark.parametrize("fields", [{"title": " "}, {"title": "x" * 121}, {"title": "Hola", "model": "--bad"}])
def test_invalid_chat_is_not_created(chat_client, fields):
    client, _ = chat_client
    project = client.post("/projects", json={"name": "Proyecto"}).json()
    base = f"/projects/{project['id']}/conversations"
    assert client.post(base, json=fields).status_code == 422
    assert client.get(base).json() == []


def test_confirmation_settings_and_missing_ids_checked_before_cli(chat_client):
    client, recorder = chat_client
    _, _, path = make_chat(client)
    assert send(client, path, connector="codex").status_code == 409
    assert send(client, path, connector="unknown").status_code == 404
    assert send(client, path, connector="mock", model="other").status_code == 422
    assert client.get(f"/projects/{uuid4()}/conversations").status_code == 404
    assert client.post(f"/projects/{uuid4()}/conversations", json={"title": "No"}).status_code == 404
    assert client.get(path.rsplit("/", 1)[0] + f"/{uuid4()}").status_code == 404
    assert recorder.calls == []


@pytest.mark.parametrize("headers", [{"Origin": "https://foreign.invalid"}, {"Origin": "null"}, {"Host": "foreign.invalid"}])
def test_chat_host_and_origin_checks(chat_client, headers):
    client, recorder = chat_client
    _, _, path = make_chat(client)
    assert client.get(path, headers=headers).status_code == 403
    assert client.post(path + "/messages", json={"content": "No"}, headers=headers).status_code == 403
    assert recorder.calls == []
    assert client.post(path + "/messages", data={"content": "No"}).status_code == 415


def test_large_context_rejected_without_truncation_or_cli(chat_client, database_path):
    client, recorder = chat_client
    _, chat, path = make_chat(client)
    with Database(database_path).connect() as connection:
        connection.execute("INSERT INTO messages VALUES (?, ?, 1, 'assistant', ?, 'mock', 'local', ?)",
                           (str(uuid4()), chat["id"], "x" * 64000, chat["created_at"]))
    assert send(client, path, connector="codex", confirm_subscription_use=True).status_code == 422
    assert recorder.calls == []
    assert len(client.get(path).json()["messages"][0]["content"]) == 64000


def test_known_credential_formats_are_redacted_before_storage_and_context(chat_client):
    client, recorder = chat_client
    _, _, path = make_chat(client)
    secret = "sk-fictitious_test_credential"
    response = send(client, path, secret, connector="codex", confirm_subscription_use=True)
    assert secret not in response.text
    assert secret not in json.dumps(recorder.calls)
    assert "[credencial omitida]" in client.get(path).text


def test_other_process_updates_history_without_overwriting_its_turn(database_path):
    class ConcurrentWriter(RecordingConnector):
        async def send(self, prompt, *, model=None):
            with Database(database_path).connect() as connection:
                for position, role in ((1, "user"), (2, "assistant")):
                    connection.execute("INSERT INTO messages VALUES (?, ?, ?, ?, ?, 'codex', 'other', ?)",
                        (str(uuid4()), chat["id"], position, role, "Otro proceso", chat["created_at"]))
            return await super().send(prompt, model=model)

    connector = ConcurrentWriter()
    with TestClient(create_app(database_path, connectors={"codex": connector}), base_url=BASE_URL) as client:
        _, chat, path = make_chat(client, connector="codex")
        response = send(client, path, connector="codex", confirm_subscription_use=True)
        assert response.status_code == 409
        messages = client.get(path).json()["messages"]
        assert [m["content"] for m in messages] == ["Otro proceso", "Otro proceso"]
        assert client.app.state.active_conversations == set()


def test_locked_chat_storage_does_not_invoke_cli_or_lose_history(chat_client, database_path):
    client, recorder = chat_client
    _, _, path = make_chat(client)
    saved = send(client, path).json()
    client.app.state.database.timeout = 0.01
    with sqlite3.connect(database_path) as lock:
        lock.execute("BEGIN EXCLUSIVE")
        assert client.get(path).status_code == 503
        assert send(client, path, connector="codex", confirm_subscription_use=True).status_code == 503
        assert recorder.calls == []
    assert client.get(path).json() == saved


def test_concurrent_send_disconnect_and_deletion_race(database_path):
    started, release = asyncio.Event(), asyncio.Event()

    class WaitingConnector(RecordingConnector):
        cancelled = False

        async def send(self, prompt, *, model=None):
            started.set()
            try:
                await release.wait()
                return await super().send(prompt, model=model)
            finally:
                self.cancelled = True

    connector = WaitingConnector()
    app = create_app(database_path, connectors={"codex": connector})
    with TestClient(app, base_url=BASE_URL) as client:
        project, chat, path = make_chat(client, connector="codex")

    async def exercise():
        disconnect = asyncio.Event()

        async def receive():
            await disconnect.wait()
            return {"type": "http.disconnect"}

        request = Request({"type": "http", "app": app}, receive)
        payload = SendMessage(content="Hola", connector="codex", confirm_subscription_use=True)

        async def invoke():
            return await send_message(UUID(project["id"]), UUID(chat["id"]), payload, app.state.database, app.state.connectors, request)

        first = asyncio.create_task(invoke())
        await started.wait()
        with pytest.raises(HTTPException) as busy:
            await invoke()
        assert busy.value.status_code == 409
        disconnect.set()
        with pytest.raises(HTTPException) as cancelled:
            await first
        assert cancelled.value.status_code == 499
        assert connector.cancelled
        assert app.state.active_conversations == set()
        with app.state.database.connect() as connection:
            assert connection.execute("SELECT count(*) FROM messages").fetchone()[0] == 0
        disconnect.clear(); started.clear()
        second = asyncio.create_task(invoke())
        await started.wait()
        with app.state.database.connect() as connection:
            connection.execute("DELETE FROM projects WHERE id = ?", (project["id"],))
        release.set()
        with pytest.raises(HTTPException) as removed:
            await second
        assert removed.value.status_code == 404
        assert app.state.active_conversations == set()

    asyncio.run(exercise())
