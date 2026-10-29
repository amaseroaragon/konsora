import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from konsora_api.cli_process import OutputLimit, ProcessTimeout, run_cli
from konsora_api.connector_routes import send_while_connected
from konsora_api.connectors import CodexCLIConnector, ConnectorError, MockConnector
from konsora_api.main import create_app

BASE_URL = "http://127.0.0.1:8000"
SECRET = "sk-fictitious_offline_test_credential"


@pytest.fixture(autouse=True)
def no_real_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KONSORA_CODEX_BIN", "/nonexistent/konsora-test-codex")
    monkeypatch.delenv("KONSORA_CODEX_MODEL", raising=False)


@pytest.fixture
def fake_cli(tmp_path: Path):
    def create(mode: str = "success", login: str = "chatgpt", version: str = "0.165.0"):
        binary = tmp_path / "codex"
        capture = tmp_path / "captured.jsonl"
        source = f'''#!{sys.executable}
import json, os, sys, time
from pathlib import Path
mode, login, version = {mode!r}, {login!r}, {version!r}
capture = Path({str(capture)!r})
args = sys.argv[1:]
if args == ["--version"]:
    print("codex-cli " + version)
elif args == ["login", "status"]:
    if login == "chatgpt":
        print("Logged in using ChatGPT", file=sys.stderr)
    elif login == "api":
        print("Logged in using an API key: {SECRET}", file=sys.stderr)
    else:
        print("Not logged in", file=sys.stderr)
        sys.exit(1)
elif args[:2] == ["debug", "models"]:
    capture.write_text(json.dumps({{"args": args, "api_env": "OPENAI_API_KEY" in os.environ, "cwd": os.getcwd()}}))
    if mode == "models_invalid":
        print("invalid {SECRET}")
    elif mode == "models_failure":
        print("failure {SECRET}", file=sys.stderr)
        sys.exit(1)
    elif mode == "models_timeout":
        time.sleep(30)
    elif mode == "models_overflow":
        print("x" * (9 * 1024 * 1024))
    else:
        print(json.dumps({{"models": [
            {{"slug": "account-model", "display_name": "Modelo de la cuenta", "visibility": "list", "base_instructions": "{SECRET}"}},
            {{"slug": "account-model", "display_name": "Duplicado", "visibility": "list"}},
            {{"slug": "hidden", "display_name": "Oculto", "visibility": "hide"}},
            {{"slug": "--unsafe", "display_name": "Inválido", "visibility": "list"}},
            {{"slug": "secret-name", "display_name": "{SECRET}", "visibility": "list"}},
        ]}}))
else:
    prompt = sys.stdin.read()
    with capture.open("a") as log:
        log.write(json.dumps({{"args": args, "prompt": prompt, "cwd": os.getcwd(),
            "git_marker": Path(".git").is_dir(),
            "api_env": any(name in os.environ for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"))
        }}) + "\\n")
    if mode == "timeout":
        time.sleep(30)
    elif mode == "overflow":
        print("x" * 600000)
    elif mode == "malformed":
        print("not-json {SECRET}")
    elif mode in ("authentication", "quota", "network", "failure"):
        detail = {{"authentication": "401 Unauthorized", "quota": "usage limit", "network": "network disconnected", "failure": "unhandled"}}[mode]
        print(detail + " {SECRET}", file=sys.stderr)
        sys.exit(1)
    else:
        if mode == "startup_error":
            print(json.dumps({{"type": "item.completed", "item": {{"type": "error", "message": "startup diagnostic {SECRET}"}}}}))
        if mode == "tool":
            print(json.dumps({{"type": "item.completed", "item": {{"type": "command_execution", "command": "should-not-run"}}}}))
        elif mode == "event_error":
            print(json.dumps({{"type": "turn.failed", "error": {{"message": "401 Unauthorized {SECRET}"}}}}))
        elif mode != "empty":
            print(json.dumps({{"type": "item.completed", "item": {{"type": "agent_message", "text": "Respuesta de Codex falso: " + prompt}}}}))
        if mode != "incomplete":
            print(json.dumps({{"type": "turn.completed", "usage": {{"input_tokens": 1}}}}))
'''
        binary.write_text(source)
        binary.chmod(0o700)
        connector = CodexCLIConnector(str(binary), workspace_root=tmp_path / "isolated", timeout=0.2 if mode == "timeout" else 5)
        return connector, capture
    return create


def test_mock_prompt_without_process_or_database(database_path: Path) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        response = client.post("/connectors/mock/prompt", json={"prompt": " Hola "})
        assert response.status_code == 200
        assert response.json() == {"connector": "mock", "model": "Simulado local", "text": "Respuesta simulada: Hola"}
    assert not database_path.exists()


@pytest.mark.parametrize("login,status", [("chatgpt", "ready"), ("api", "api_login"), ("none", "login_required")])
def test_login_detection_does_not_infer_or_expose_output(fake_cli, login: str, status: str) -> None:
    connector, capture = fake_cli(login=login)
    info = asyncio.run(connector.info())
    assert info.status == status
    assert SECRET not in info.model_dump_json()
    assert not capture.exists()


def test_missing_cli_and_unsupported_version(fake_cli) -> None:
    assert asyncio.run(CodexCLIConnector().info()).status == "missing"
    for version in ("0.1.0", "0.166.0", "unknown"):
        connector, capture = fake_cli(version=version)
        assert asyncio.run(connector.info()).status == "unsupported"
        assert not capture.exists()


def test_safe_process_contract_and_plain_text(fake_cli, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"):
        monkeypatch.setenv(name, SECRET)
    connector, capture = fake_cli()
    prompt = 'Hola; $(touch no-ejecutar) `pwd`\n<b>Texto</b> ñ'
    result = asyncio.run(connector.send(prompt))
    assert result.text == f"Respuesta de Codex falso: {prompt}"
    saved = json.loads(capture.read_text())
    assert saved["prompt"] == prompt
    assert saved["api_env"] is False
    assert saved["git_marker"] is True
    args = saved["args"]
    assert args[0] == "exec" and args[-1] == "-"
    assert prompt not in args
    assert args[args.index("--sandbox") + 1] == "read-only"
    assert "--ignore-user-config" in args and "--ephemeral" in args
    assert 'forced_login_method="chatgpt"' in args
    assert 'model_provider="openai"' in args
    assert 'approval_policy="never"' in args
    for feature in ("shell_tool", "plugins", "hooks", "apps", "multi_agent", "code_mode"):
        assert ["--disable", feature] in [args[i:i + 2] for i in range(len(args) - 1)]
    assert not any("dangerous" in arg or "full-access" in arg or "workspace-write" in arg for arg in args)
    assert not Path(saved["cwd"]).exists()


def test_api_login_is_rechecked_and_never_runs(fake_cli) -> None:
    connector, _ = fake_cli()
    assert asyncio.run(connector.info()).status == "ready"
    _, capture = fake_cli(login="api")
    with pytest.raises(ConnectorError) as error:
        asyncio.run(connector.send("Hola"))
    assert error.value.code == "api_login"
    assert not capture.exists()


def test_model_is_backend_configuration_only(fake_cli) -> None:
    connector, capture = fake_cli()
    connector._model = "account-model"
    result = asyncio.run(connector.send("Hola"))
    assert result.model == "account-model"
    args = json.loads(capture.read_text())["args"]
    assert args[args.index("--model") + 1] == "account-model"
    connector._model = SECRET
    info = asyncio.run(connector.info())
    assert info.status == "unsupported"
    assert SECRET not in info.model_dump_json()


def test_chat_model_override_is_per_call_and_keeps_isolation(fake_cli, database_path: Path) -> None:
    connector, capture = fake_cli()
    connector._model = "backend-default"
    with TestClient(create_app(database_path, connectors={"codex": connector}), base_url=BASE_URL) as client:
        project = client.post("/projects", json={"name": "Proyecto"}).json()
        base = f"/projects/{project['id']}/conversations"
        chat = client.post(base, json={"title": "Chat", "connector": "codex", "model": "account-model"}).json()
        response = client.post(f"{base}/{chat['id']}/messages", json={
            "content": "Hola", "connector": "codex", "model": "account-model", "confirm_subscription_use": True,
        })
        assert response.status_code == 200
        assert response.json()["messages"][1]["model"] == "account-model"
    args = json.loads(capture.read_text())["args"]
    assert args[args.index("--model") + 1] == "account-model"
    assert args[args.index("--sandbox") + 1] == "read-only"
    assert "--ignore-user-config" in args and "--ephemeral" in args
    assert connector.model == "backend-default"
    assert asyncio.run(connector.send("Siguiente")).model == "backend-default"
    with pytest.raises(ConnectorError) as error:
        asyncio.run(connector.send("Hola", model="--bad"))
    assert error.value.code == "model"


def test_models_catalog_uses_official_command_without_inference_or_secrets(fake_cli, database_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", SECRET)
    connector, capture = fake_cli()
    with TestClient(create_app(database_path, connectors={"codex": connector, "mock": MockConnector()}), base_url=BASE_URL) as client:
        response = client.get("/connectors/codex/models")
        assert response.status_code == 200
        assert response.json() == [{"id": "account-model", "name": "Modelo de la cuenta"}]
        assert SECRET not in response.text
        assert client.get("/connectors/mock/models").json() == []
        assert client.get("/connectors/unknown/models").status_code == 404
        assert client.get("/connectors/codex/models", headers={"Origin": "https://foreign.invalid"}).status_code == 403
        assert client.get("/connectors/codex/models", headers={"Host": "foreign.invalid"}).status_code == 403
    captured = json.loads(capture.read_text())
    assert captured["args"][:2] == ["debug", "models"]
    assert 'forced_login_method="chatgpt"' in captured["args"]
    assert 'model_provider="openai"' in captured["args"]
    assert captured["api_env"] is False
    assert not Path(captured["cwd"]).exists()
    assert not database_path.exists()


@pytest.mark.parametrize("login", ["api", "none"])
def test_catalog_rejects_non_chatgpt_sessions_before_query(fake_cli, database_path, login):
    connector, capture = fake_cli(login=login)
    with TestClient(create_app(database_path, connectors={"codex": connector}), base_url=BASE_URL) as client:
        assert client.get("/connectors/codex/models").status_code == 503
    assert not capture.exists()


@pytest.mark.parametrize("mode,status", [("models_invalid", 502), ("models_failure", 502), ("models_timeout", 503), ("models_overflow", 503)])
def test_catalog_errors_are_bounded_and_controlled(fake_cli, database_path, monkeypatch, mode, status, caplog):
    from konsora_api import connectors as module
    original = module.run_cli

    async def short_timeout(args, **kwargs):
        if args[1:3] == ["debug", "models"]:
            kwargs["timeout"] = 0.1 if mode == "models_timeout" else 5
        return await original(args, **kwargs)

    monkeypatch.setattr(module, "run_cli", short_timeout)
    connector, _ = fake_cli(mode=mode)
    with TestClient(create_app(database_path, connectors={"codex": connector}), base_url=BASE_URL) as client:
        response = client.get("/connectors/codex/models")
        assert response.status_code == status
        assert response.json()["code"] == "models"
        assert SECRET not in response.text + caplog.text
    assert list(connector._workspace_root.iterdir()) == []


@pytest.mark.parametrize("catalog", [None, [], {"models": "invalid"}, {"models": [None]}])
def test_catalog_schema_rejected_without_raw_output(catalog):
    with pytest.raises(ConnectorError) as error:
        CodexCLIConnector.parse_models(json.dumps(catalog).encode())
    assert error.value.code == "models"


@pytest.mark.parametrize("mode,status,code", [
    ("authentication", 401, "authentication"), ("quota", 429, "quota"),
    ("network", 502, "network"), ("failure", 502, "cli_failed"),
    ("timeout", 504, "timeout"), ("overflow", 502, "output_limit"),
    ("malformed", 502, "invalid_output"), ("tool", 502, "unexpected_tool"),
    ("empty", 502, "incomplete"), ("incomplete", 502, "incomplete"),
    ("event_error", 401, "authentication"),
])
def test_cli_errors_are_controlled(fake_cli, database_path: Path, mode: str, status: int, code: str, caplog: pytest.LogCaptureFixture) -> None:
    connector, capture = fake_cli(mode=mode)
    caplog.set_level(logging.DEBUG)
    with TestClient(create_app(database_path, connectors={"codex": connector}), base_url=BASE_URL) as client:
        response = client.post("/connectors/codex/prompt", json={"prompt": "Hola", "confirm_subscription_use": True})
    assert response.status_code == status
    assert response.json()["code"] == code
    assert SECRET not in response.text + caplog.text
    assert len(capture.read_text().splitlines()) == 1
    assert list(connector._workspace_root.iterdir()) == []


def test_response_redacts_known_credentials(fake_cli, caplog: pytest.LogCaptureFixture) -> None:
    connector, _ = fake_cli()
    caplog.set_level(logging.DEBUG)
    text = asyncio.run(connector.send(f"{SECRET} Bearer fictitious-token eyJoffline.payload.signature")).text
    assert SECRET not in text + caplog.text
    assert "Bearer fictitious-token" not in text
    assert "eyJoffline.payload.signature" not in text
    assert "[credencial omitida]" in text


def test_nonfatal_diagnostics_are_omitted_when_turn_completes(fake_cli) -> None:
    connector, _ = fake_cli(mode="startup_error")
    result = asyncio.run(connector.send("Hola"))
    assert result.text == "Respuesta de Codex falso: Hola"
    assert SECRET not in result.model_dump_json()


def test_confirmation_required_before_cli(fake_cli, database_path: Path) -> None:
    connector, capture = fake_cli()
    with TestClient(create_app(database_path, connectors={"codex": connector}), base_url=BASE_URL) as client:
        assert client.post("/connectors/codex/prompt", json={"prompt": "Hola"}).status_code == 409
        assert not capture.exists()
        assert client.post("/connectors/codex/prompt", json={"prompt": "Hola", "confirm_subscription_use": True}).status_code == 200
        assert client.post("/connectors/unknown/prompt", json={"prompt": "Hola"}).status_code == 404


@pytest.mark.parametrize("payload", [
    {"prompt": " "}, {"prompt": "x" * 16001}, {"prompt": None},
    {"prompt": "Hola", "api_key": SECRET}, {"prompt": "Hola", "command": "anything"},
    {"prompt": "Hola", "confirm_subscription_use": "true"},
])
def test_input_validation_never_echoes_fields(database_path: Path, payload: dict) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        response = client.post("/connectors/codex/prompt", json=payload)
    assert response.status_code == 422
    assert SECRET not in response.text
    assert "input" not in response.json()


@pytest.mark.parametrize("origin", ["https://example.com", "null", "http://localhost:9999"])
def test_foreign_websites_cannot_query_or_send(database_path: Path, origin: str) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        assert client.get("/connectors", headers={"Origin": origin}).status_code == 403
        assert client.post("/connectors/mock/prompt", headers={"Origin": origin}, json={"prompt": "Hola"}).status_code == 403


def test_dns_rebinding_and_form_submission_rejected(database_path: Path) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        assert client.get("/connectors", headers={"Host": "foreign.invalid"}).status_code == 403
        assert client.post("/connectors/mock/prompt", data={"prompt": "Hola"}).status_code == 415


@pytest.mark.parametrize("origin", ["http://127.0.0.1:1420", "http://localhost:1420", "tauri://localhost", "http://tauri.localhost"])
def test_allowed_ui_origins(database_path: Path, origin: str) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        response = client.get("/connectors", headers={"Origin": origin})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin
        assert response.json()[1]["status"] == "missing"


def test_busy_and_cancellation_release_lock(fake_cli) -> None:
    connector, capture = fake_cli(mode="timeout")

    async def exercise():
        task = asyncio.create_task(connector.send("Hola"))
        for _ in range(100):
            if capture.exists():
                break
            await asyncio.sleep(0.01)
        assert capture.exists()
        with pytest.raises(ConnectorError) as error:
            await connector.send("Duplicada")
        assert error.value.code == "busy"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not connector._busy.locked()
        assert list(connector._workspace_root.iterdir()) == []
    asyncio.run(exercise())


def test_disconnect_cancels_connector() -> None:
    class WaitingConnector:
        cancelled = False

        async def send(self, prompt):
            try:
                await asyncio.sleep(30)
            finally:
                self.cancelled = True

    class Disconnected:
        async def receive(self):
            await asyncio.sleep(0.01)
            return {"type": "http.disconnect"}

    connector = WaitingConnector()
    with pytest.raises(HTTPException) as error:
        asyncio.run(send_while_connected(connector, "Hola", Disconnected()))
    assert error.value.status_code == 499
    assert connector.cancelled


@pytest.mark.parametrize("action", ["timeout", "cancel", "output"])
def test_process_limits_kill_child_group(tmp_path: Path, action: str) -> None:
    pid_file = tmp_path / "child-pid"
    script = tmp_path / "process.py"
    script.write_text(
        "import os,subprocess,sys,time\n"
        f"child=subprocess.Popen([{sys.executable!r}, '-c', 'import time;time.sleep(30)'])\n"
        f"open({str(pid_file)!r},'w').write(str(child.pid))\n"
        + ("sys.stdout.write('x'*100000);sys.stdout.flush()\n" if action == "output" else "")
        + "time.sleep(30)\n"
    )

    async def exercise():
        task = asyncio.create_task(run_cli([sys.executable, str(script)], cwd=tmp_path, timeout=0.3, output_limit=10000))
        if action == "cancel":
            for _ in range(100):
                if pid_file.exists():
                    break
                await asyncio.sleep(0.01)
            task.cancel()
        expected = {"timeout": ProcessTimeout, "cancel": asyncio.CancelledError, "output": OutputLimit}[action]
        with pytest.raises(expected):
            await task
    asyncio.run(exercise())
    pid = int(pid_file.read_text())
    stat = Path(f"/proc/{pid}/stat")
    assert not stat.exists() or stat.read_text().split()[2] == "Z"
