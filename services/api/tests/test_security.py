import pytest
from fastapi.testclient import TestClient
from konsora_api.main import create_app

TOKEN = "a" * 64
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Origin": "tauri://localhost"}

@pytest.mark.parametrize("change", [
    {"Authorization": ""}, {"Authorization": "Bearer incorrecto"},
    {"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": ""},
    {"Host": "evil.example:8000"}, {"Host": "127.0.0.1:8001"},
])
def test_denied_clients_cannot_read_or_write(tmp_path, change):
    app = create_app(tmp_path / "db.sqlite3", instance_token=TOKEN)
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 1)) as client:
        for method, path in [("GET", "/health"), ("GET", "/projects"), ("POST", "/projects")]:
            response = client.request(method, path, headers={**HEADERS, **change}, json={"name": "No crear"})
            assert response.status_code == 403
            assert TOKEN not in response.text
            assert response.headers["cache-control"] == "no-store"
        assert client.get("/projects", headers=HEADERS).json() == []


def test_remote_peer_and_duplicate_headers_denied(tmp_path):
    app = create_app(tmp_path / "db.sqlite3", instance_token=TOKEN)
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("192.168.1.1", 1)) as client:
        assert client.get("/projects", headers=HEADERS).status_code == 403
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 1)) as client:
        for name, value in HEADERS.items():
            headers = list(HEADERS.items()) + [(name, value)]
            assert client.get("/projects", headers=headers).status_code == 403
        response = client.get("/health", headers=HEADERS)
        assert response.status_code == 200
        assert TOKEN not in response.text
        assert TOKEN not in str(response.headers)
