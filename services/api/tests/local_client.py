from fastapi.testclient import TestClient as RawTestClient

class TestClient(RawTestClient):
    __test__ = False
    def __init__(self, app, **kwargs):
        kwargs["base_url"] = "http://127.0.0.1:8000"
        kwargs["client"] = ("127.0.0.1", 50000)
        kwargs["headers"] = {"Authorization": f"Bearer {app.state.instance_token}", "Origin": "tauri://localhost"}
        super().__init__(app, **kwargs)
