import sqlite3
from pathlib import Path
import pytest
from konsora_api.database import Database
from konsora_api.maintenance import data_lock, diagnostics, import_registry
from konsora_api.server import private_directory


def test_import_preserves_all_tables_key_and_original(tmp_path):
    source = tmp_path / 'old' / 'registry.sqlite3'
    with Database(source).connect() as connection:
        connection.execute("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p','Anterior','2026-01-01','2026-01-01')")
        connection.execute('CREATE TABLE custom_history (value TEXT)')
        connection.execute("INSERT INTO custom_history VALUES ('Conservar')")
    key = source.parent / 'instance-review.key'; key.write_bytes(b'x'*32)
    before = source.read_bytes()
    directory = private_directory(tmp_path/'new')
    with data_lock(directory):
        result = import_registry(source,directory)
        assert result['projects']==1 and result['review_key_preserved']
        with sqlite3.connect(directory/'konsora.sqlite3') as copy:
            assert copy.execute('SELECT * FROM custom_history').fetchall()==[('Conservar',)]
        assert diagnostics(directory)['integrity']=='ok'
        with pytest.raises(ValueError):import_registry(source,directory)
    assert source.read_bytes()==before and key.read_bytes()==b'x'*32
    assert (directory/'instance-review.key').read_bytes()==key.read_bytes()
    assert (directory/'konsora.sqlite3').stat().st_mode&0o777==0o600
    assert (directory/'instance-review.key').stat().st_mode&0o777==0o600


def test_lock_refuses_active_owner_and_bad_import_keeps_destination_empty(tmp_path):
    directory=private_directory(tmp_path/'new')
    with data_lock(directory):
        with pytest.raises(ValueError):
            with data_lock(directory):pass
    source=tmp_path/'bad.sqlite3';source.write_text('No SQLite')
    with pytest.raises(sqlite3.Error):import_registry(source,directory)
    assert not (directory/'konsora.sqlite3').exists()
    assert source.read_text()=='No SQLite'


def test_private_directory_rejects_symlink(tmp_path):
    real=tmp_path/'real';real.mkdir();link=tmp_path/'link';link.symlink_to(real)
    with pytest.raises(ValueError):private_directory(link)
