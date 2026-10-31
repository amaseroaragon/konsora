import pytest
from local_client import TestClient


def test_health_returns_service_contract(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "konsora-api"}
    assert response.headers["content-type"] == "application/json"


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "tauri://localhost",
        "http://tauri.localhost",
    ],
)
def test_health_allows_desktop_origins(client: TestClient, origin: str) -> None:
    response = client.get("/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in response.headers


def test_health_does_not_allow_external_origin(client: TestClient) -> None:
    response = client.get("/health", headers={"Origin": "https://example.com"})

    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers
