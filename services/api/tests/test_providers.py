import asyncio
import logging
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from konsora_api.main import create_app
from konsora_api.providers import MockProvider, OpenAIProvider, ProviderError


# Valores ficticios exclusivos de los tests; nunca se usan credenciales reales.
TEST_CREDENTIAL = "fictitious-credential-for-offline-tests"
MODEL = "test-model"
PAYLOAD = {"model": MODEL, "prompt": "Hola", "max_output_tokens": 128}
BASE_URL = "http://127.0.0.1:8000"


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("KONSORA_OPENAI_MODEL", raising=False)

    async def forbid_network(*args, **kwargs):
        raise AssertionError("Las pruebas de proveedores no deben acceder a internet.")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", forbid_network)


def response_body(text: str = "Hola desde la API simulada") -> dict:
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": text},
            ]},
        ],
    }


def api(database_path: Path, handler) -> TestClient:
    provider = OpenAIProvider(
        SecretStr(TEST_CREDENTIAL), MODEL, transport=httpx.MockTransport(handler),
    )
    return TestClient(create_app(database_path, providers={"mock": MockProvider(), "openai": provider}), base_url=BASE_URL)


def test_mock_is_deterministic_and_validates_model() -> None:
    provider = MockProvider()
    first = asyncio.run(provider.generate("mock-text", "Una idea", 128))
    assert first == asyncio.run(provider.generate("mock-text", "Una idea", 128))
    assert first.provider == "mock"
    assert "Una idea" in first.text
    with pytest.raises(ProviderError, match="modelo configurado"):
        asyncio.run(provider.generate("unknown", "Hola", 128))


def test_unconfigured_and_mock_flow(database_path: Path) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        providers = client.get("/providers").json()
        assert providers[0]["available"] is True
        assert providers[1]["id"] == "openai"
        assert providers[1]["available"] is False
        assert providers[1]["models"] == []
        response = client.post("/providers/mock/generate", json={"model": "mock-text", "prompt": " Hola "})
        assert response.status_code == 200
        assert response.json() == {"provider": "mock", "model": "mock-text", "text": "Respuesta simulada. He recibido tu prompt: Hola"}
        assert client.post("/providers/openai/generate", json=PAYLOAD).status_code == 503
        assert client.post("/providers/unknown/generate", json=PAYLOAD).status_code == 404
    # Una prueba de modelo no abre SQLite ni guarda el prompt.
    assert not database_path.exists()


def test_backend_environment_configuration_is_not_serialized(database_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", TEST_CREDENTIAL)
    monkeypatch.setenv("KONSORA_OPENAI_MODEL", MODEL)
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        response = client.get("/providers")
        assert response.status_code == 200
        assert TEST_CREDENTIAL not in response.text
        provider = response.json()[1]
        assert provider["available"] is True
        assert provider["models"] == [MODEL]
        assert set(provider) == {"id", "name", "available", "models", "detail"}


@pytest.mark.parametrize("key,model", [
    ("", MODEL), (TEST_CREDENTIAL, ""), ("bad\nheader", MODEL),
    (TEST_CREDENTIAL, "bad\nmodel"), (TEST_CREDENTIAL, TEST_CREDENTIAL),
])
def test_incomplete_or_invalid_configuration_is_disabled(key: str, model: str) -> None:
    provider = OpenAIProvider(SecretStr(key), model)
    assert provider.info().available is False
    assert TEST_CREDENTIAL not in provider.info().model_dump_json()


def test_official_rest_contract_and_secret_redaction(database_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    monkeypatch.setenv("OPENAI_BASE_URL", "https://untrusted.invalid")
    monkeypatch.setenv("HTTPS_PROXY", "https://untrusted.invalid")

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        calls.append(request)
        assert str(request.url) == "https://api.openai.com/v1/responses"
        assert request.headers["authorization"] == f"Bearer {TEST_CREDENTIAL}"
        assert json.loads(request.content) == {
            "model": MODEL, "input": "Hola", "max_output_tokens": 128, "store": False,
        }
        assert TEST_CREDENTIAL.encode() not in request.content
        return httpx.Response(200, json=response_body(f"Texto {TEST_CREDENTIAL} <script>inofensivo</script>"))

    caplog.set_level(logging.DEBUG)
    with api(database_path, handler) as client:
        assert TEST_CREDENTIAL not in client.get("/providers").text
        response = client.post("/providers/openai/generate", json=PAYLOAD)
        assert response.status_code == 200
        assert response.json() == {"provider": "openai", "model": MODEL, "text": "Texto [credencial omitida] <script>inofensivo</script>"}
        assert TEST_CREDENTIAL not in response.text
    assert len(calls) == 1
    assert TEST_CREDENTIAL not in caplog.text


@pytest.mark.parametrize("remote_status,status,code", [
    (400, 422, "invalid_request"), (401, 401, "authentication"),
    (403, 403, "permission"), (404, 422, "model_unavailable"),
    (429, 429, "rate_limit"), (500, 502, "upstream"), (503, 502, "upstream"),
    (302, 502, "upstream"),
])
def test_remote_errors_are_sanitized_and_never_retried(database_path: Path, remote_status: int, status: int, code: str, caplog: pytest.LogCaptureFixture) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(remote_status, json={"error": {"message": TEST_CREDENTIAL}}, headers={"Location": "https://untrusted.invalid"})

    caplog.set_level(logging.DEBUG)
    with api(database_path, handler) as client:
        response = client.post("/providers/openai/generate", json=PAYLOAD)
    assert response.status_code == status
    assert response.json()["code"] == code
    assert TEST_CREDENTIAL not in response.text + caplog.text
    assert len(calls) == 1


@pytest.mark.parametrize("exception,status,code", [
    (httpx.ConnectError, 502, "network"), (httpx.ReadTimeout, 504, "timeout"),
])
def test_network_failures_do_not_expose_exception(database_path: Path, exception, status: int, code: str, caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception(TEST_CREDENTIAL, request=request)

    caplog.set_level(logging.DEBUG)
    with api(database_path, handler) as client:
        response = client.post("/providers/openai/generate", json=PAYLOAD)
    assert response.status_code == status
    assert response.json()["code"] == code
    assert TEST_CREDENTIAL not in response.text + caplog.text


@pytest.mark.parametrize("body", [None, [], {}, {"status": "incomplete"}, {"status": "completed", "output": None}, {"status": "completed", "output": [None, {"type": "message", "role": "assistant", "content": None}]}, response_body(""), {"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "refusal", "refusal": "No"}]}]}])
def test_malformed_incomplete_or_empty_responses(database_path: Path, body) -> None:
    with api(database_path, lambda request: httpx.Response(200, json=body)) as client:
        response = client.post("/providers/openai/generate", json=PAYLOAD)
    assert response.status_code == 502
    assert "detail" in response.json()


def test_non_json_response(database_path: Path) -> None:
    with api(database_path, lambda request: httpx.Response(200, text="invalid-json")) as client:
        response = client.post("/providers/openai/generate", json=PAYLOAD)
    assert response.status_code == 502
    assert response.json()["code"] == "invalid_response"


@pytest.mark.parametrize("change", [
    {"prompt": " "}, {"prompt": "x" * 16001}, {"prompt": None},
    {"model": ""}, {"model": "x" * 201}, {"model": "invalid\nmodel"},
    {"max_output_tokens": 15}, {"max_output_tokens": 2049}, {"max_output_tokens": True},
    {"max_output_tokens": "128"}, {"api_key": TEST_CREDENTIAL}, {"base_url": "https://untrusted.invalid"},
])
def test_validation_never_echoes_input_or_calls_provider(database_path: Path, change: dict) -> None:
    def forbidden(request: httpx.Request) -> httpx.Response:
        pytest.fail("Un prompt inválido no debe llegar al proveedor.")

    with api(database_path, forbidden) as client:
        response = client.post("/providers/openai/generate", json=PAYLOAD | change)
    assert response.status_code == 422
    assert TEST_CREDENTIAL not in response.text
    assert "input" not in response.json()


def test_unknown_model_never_calls_provider(database_path: Path) -> None:
    def forbidden(request: httpx.Request) -> httpx.Response:
        pytest.fail("Un modelo ajeno a la configuración no debe enviarse.")

    with api(database_path, forbidden) as client:
        response = client.post("/providers/openai/generate", json=PAYLOAD | {"model": "unknown"})
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_model"


@pytest.mark.parametrize("origin", ["https://example.com", "null", "http://127.0.0.1:9999"])
def test_untrusted_origins_cannot_access_providers(database_path: Path, origin: str) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        headers = {"Origin": origin}
        assert client.get("/providers", headers=headers).status_code == 403
        assert client.post("/providers/mock/generate", headers=headers, json={"model": "mock-text", "prompt": "Hola"}).status_code == 403


def test_untrusted_host_and_form_submission_are_rejected(database_path: Path) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        assert client.get("/providers", headers={"Host": "attacker.invalid:8000"}).status_code == 403
        response = client.post("/providers/mock/generate", data={"model": "mock-text", "prompt": "Hola"})
        assert response.status_code == 415


@pytest.mark.parametrize("origin", ["http://127.0.0.1:1420", "http://localhost:1420", "tauri://localhost", "http://tauri.localhost"])
def test_local_ui_can_list_and_generate(database_path: Path, origin: str) -> None:
    with TestClient(create_app(database_path), base_url=BASE_URL) as client:
        headers = {"Origin": origin}
        assert client.get("/providers", headers=headers).status_code == 200
        response = client.post("/providers/mock/generate", headers=headers, json={"model": "mock-text", "prompt": "Hola"})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin
