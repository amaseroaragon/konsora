import json

import pytest

from test_file_tasks import external, register


pytestmark = pytest.mark.usefixtures("forbid_processes")


@pytest.fixture
def selected_project(client, tmp_path):
    folder = tmp_path / "project"
    _, base = register(client, folder)
    path = external(folder, [
        {"id": "A", "title": "Seleccionada A", "description": "Solo alcance A", "acceptance_criteria": "Comprobar A"},
        {"id": "B", "title": "NO_INCLUIR_TRABAJO_B", "description": "CONTEXTO_PRIVADO_B", "sort_order": 1},
        {"id": "C", "title": "Seleccionada C", "dependencies": ["B"], "sort_order": 2},
    ])
    (folder / "privado.txt").write_text("NO_LEER_ARCHIVOS_IMPLICITAMENTE")
    request = {"task_ids": ["A", "C"], "expected_revision": client.get(base + "/board").json()["source"]["revision"],
               "context": "Contexto expresamente autorizado"}
    return folder, path, base, request


def test_only_selected_work_and_authorized_context_without_session(client, selected_project):
    folder, path, base, request = selected_project
    original = path.read_bytes()
    response = client.post(base + "/prompt/preview", json=request)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["task_ids"] == ["A", "C"]
    assert data["blocked"] == [{"task_id": "C", "dependency_id": "B", "selected": False}]
    assert "Seleccionada A" in data["text"] and "Seleccionada C" in data["text"] and request["context"] in data["text"]
    assert "NO_INCLUIR_TRABAJO_B" not in data["text"] and "CONTEXTO_PRIVADO_B" not in data["text"]
    assert "NO_LEER_ARCHIVOS_IMPLICITAMENTE" not in data["text"]
    assert path.read_bytes() == original and not (folder / ".konsora/prompts").exists()
    assert not (client.app.state.database.path.parent / "instance-review.key").exists()


def test_changed_file_or_context_invalidates_preview_without_version_increment(client, selected_project):
    _, path, base, request = selected_project
    prepared = client.post(base + "/prompt/preview", json=request).json()
    checked = {**request, "prompt_fingerprint": prepared["fingerprint"]}
    assert client.post(base + "/prompt/validate", json=checked).status_code == 200
    assert client.post(base + "/prompt/validate", json={**checked, "context": "Cambio de contexto"}).status_code == 409
    data = json.loads(path.read_text()); data["tasks"][0]["description"] = "Cambio externo"
    path.write_text(json.dumps(data))
    assert client.post(base + "/prompt/validate", json=checked).status_code == 409
    assert client.post(base + "/prompt/save", json={**checked, "filename": "no-guardar.md"}).status_code == 409
    assert not (path.parent / "prompts").exists()


def test_explicit_save_preserves_source_and_never_overwrites(client, selected_project):
    folder, path, base, request = selected_project
    original = path.read_bytes()
    prepared = client.post(base + "/prompt/preview", json=request).json()
    body = {**request, "prompt_fingerprint": prepared["fingerprint"], "filename": "lote-elegido.md"}
    response = client.post(base + "/prompt/save", json=body)
    assert response.status_code == 201, response.text
    target = folder / response.json()["path"]
    assert target.read_text() == prepared["text"] and path.read_bytes() == original
    assert client.post(base + "/prompt/save", json=body).status_code == 409
    assert target.read_text() == prepared["text"]
    assert not list(target.parent.glob("*.tmp"))


@pytest.mark.parametrize("filename", ["../escape.md", "/tmp/escape.md", "tasks.json"])
def test_export_destination_is_scoped_to_prompt_directory(client, selected_project, filename):
    _, path, base, request = selected_project
    prepared = client.post(base + "/prompt/preview", json=request).json()
    response = client.post(base + "/prompt/save", json={**request, "prompt_fingerprint": prepared["fingerprint"], "filename": filename})
    assert response.status_code == 422 and not (path.parent / "prompts").exists()


def test_prompt_directory_symlink_is_rejected(client, selected_project, tmp_path):
    _, path, base, request = selected_project
    outside = tmp_path / "outside"; outside.mkdir()
    (path.parent / "prompts").symlink_to(outside, target_is_directory=True)
    prepared = client.post(base + "/prompt/preview", json=request).json()
    response = client.post(base + "/prompt/save", json={**request, "prompt_fingerprint": prepared["fingerprint"], "filename": "safe.md"})
    assert response.status_code == 503 and list(outside.iterdir()) == []


def test_invalid_selection_does_not_add_tasks_implicitly(client, selected_project):
    _, _, base, request = selected_project
    assert client.post(base + "/prompt/preview", json={**request, "task_ids": ["A", "missing"]}).status_code == 404
    assert client.post(base + "/prompt/preview", json={**request, "task_ids": ["A", "A"]}).status_code == 422
    assert client.post(base + "/prompt/preview", json={**request, "task_ids": []}).status_code == 422
