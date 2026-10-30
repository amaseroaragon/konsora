import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from konsora_api.main import create_app


def test_associate_change_detach_restart_and_delete_preserve_files(client, database_path, tmp_path):
    folder = tmp_path / "Proyecto con espacios"
    folder.mkdir()
    sentinel = folder / "original.txt"
    sentinel.write_bytes(b"Conservar exactamente")
    other = tmp_path / "Otro proyecto"
    other.mkdir()
    project = client.post("/projects", json={"name": "Carpeta"}).json()
    base = f"/projects/{project['id']}"
    assert project["workspace_path"] is None and project["workspace_status"] == "unassigned"
    saved = client.patch(base + "/workspace", json={"workspace_path": str(folder)}).json()
    assert saved["workspace_path"] == str(folder.resolve()) and saved["workspace_status"] == "ready"
    with TestClient(create_app(database_path)) as restarted:
        assert restarted.get(base).json() == saved
    assert client.patch(base, json={"name": "Renombrado"}).json()["workspace_path"] == str(folder)
    assert client.patch(base + "/workspace", json={"workspace_path": str(other)}).json()["workspace_path"] == str(other)
    assert client.patch(base + "/workspace", json={"workspace_path": None}).json()["workspace_status"] == "unassigned"
    assert client.patch(base + "/workspace", json={"workspace_path": str(folder)}).status_code == 200
    assert client.delete(base).status_code == 422
    assert client.delete(base + "?confirm=true").status_code == 204
    assert list(folder.iterdir()) == [sentinel]
    assert sentinel.read_bytes() == b"Conservar exactamente"
    assert list(other.iterdir()) == []


@pytest.mark.parametrize("path", ["/", "/home", str(Path.home()), "/etc", "/usr", "/tmp", "relative", "", "\x00"])
def test_unsafe_and_invalid_paths_do_not_change_project(client, path):
    project = client.post("/projects", json={"name": "Intacto"}).json()
    base = f"/projects/{project['id']}"
    assert client.patch(base + "/workspace", json={"workspace_path": path}).status_code == 422
    assert client.get(base).json() == project


def test_missing_file_and_loop_paths_are_rejected_and_lost_folder_is_recoverable(client, tmp_path):
    folder = tmp_path / "carpeta"
    file = tmp_path / "archivo"
    file.write_text("Conservar")
    loop = tmp_path / "loop"
    loop.symlink_to(loop)
    project = client.post("/projects", json={"name": "Recuperable"}).json()
    base = f"/projects/{project['id']}"
    for path in (folder, file, loop):
        assert client.patch(base + "/workspace", json={"workspace_path": str(path)}).status_code == 422
    folder.mkdir()
    assert client.patch(base + "/workspace", json={"workspace_path": str(folder)}).status_code == 200
    folder.rmdir()
    assert client.get(base).json()["workspace_status"] == "missing"
    assert client.get("/projects").json()[0]["workspace_path"] == str(folder)
    folder.mkdir()
    assert client.get(base).json()["workspace_status"] == "ready"


def test_symlinks_are_canonicalized_and_later_redirection_is_unsafe(client, tmp_path):
    folder = tmp_path / "real"
    folder.mkdir()
    link = tmp_path / "link"
    link.symlink_to(folder, target_is_directory=True)
    project = client.post("/projects", json={"name": "Enlace"}).json()
    base = f"/projects/{project['id']}"
    saved = client.patch(base + "/workspace", json={"workspace_path": str(link)}).json()
    assert saved["workspace_path"] == str(folder.resolve())
    link.unlink()
    link.symlink_to("/etc", target_is_directory=True)
    assert client.get(base).json()["workspace_status"] == "ready"
    assert client.patch(base + "/workspace", json={"workspace_path": str(link)}).status_code == 422
    folder.rmdir()
    other = tmp_path / "other"
    other.mkdir()
    folder.symlink_to(other, target_is_directory=True)
    assert client.get(base).json()["workspace_status"] == "unsafe"


def test_permission_errors_are_recoverable_without_writes(client, tmp_path, monkeypatch):
    folder = tmp_path / "permisos"
    folder.mkdir()
    project = client.post("/projects", json={"name": "Permisos"}).json()
    base = f"/projects/{project['id']}"
    assert client.patch(base + "/workspace", json={"workspace_path": str(folder)}).status_code == 200
    with monkeypatch.context() as patch:
        patch.setattr("konsora_api.workspaces.os.access", lambda *_: False)
        assert client.get(base).json()["workspace_status"] == "inaccessible"
        response = client.patch(base + "/workspace", json={"workspace_path": str(folder)})
        assert response.status_code == 422 and "permisos" in response.json()["detail"]
    assert client.get(base).json()["workspace_status"] == "ready"
    assert list(folder.iterdir()) == []


def test_folder_update_rolls_back_on_storage_error(client, database_path, tmp_path):
    project = client.post("/projects", json={"name": "Rollback"}).json()
    base = f"/projects/{project['id']}"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TRIGGER reject_folder BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'private error'); END")
    response = client.patch(base + "/workspace", json={"workspace_path": str(tmp_path)})
    assert response.status_code == 503 and "private error" not in response.text
    assert client.get(base).json() == project
