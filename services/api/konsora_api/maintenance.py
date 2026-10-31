"""Mantenimiento local explícito: bloqueo, diagnóstico e importación sin sobrescribir."""

import fcntl
import json
import os
import sqlite3
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

from konsora_api.database import Database, MIGRATIONS


@contextmanager
def data_lock(directory: Path):
    fd = os.open(directory / "registry.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError("Bloqueo de datos no válido.")
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Cierra Konsora antes de realizar mantenimiento; el registro está en uso.") from None
        yield
    finally:
        os.close(fd)


@contextmanager
def read_database(path: Path):
    connection = sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=1)
    try:
        yield connection
    finally:
        connection.close()


def import_registry(source: Path, directory: Path):
    source = source.expanduser().resolve(strict=True)
    target = directory / "konsora.sqlite3"
    key_target = directory / "instance-review.key"
    if not source.is_file() or source == target or target.exists() or key_target.exists():
        raise ValueError("La importación exige una base de origen y un destino nuevo, sin registro ni clave existentes.")
    key = None
    key_source = source.parent / "instance-review.key"
    if key_source.exists() or key_source.is_symlink():
        fd = os.open(key_source, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            key = stream.read(33)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or len(key) != 32:
                raise ValueError("Clave de revisiones de origen no válida; no se ha importado el registro.")
    created = []
    try:
        with read_database(source) as original:
            if original.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("La base de origen necesita revisión.")
            if original.execute("PRAGMA user_version").fetchone()[0] > len(MIGRATIONS):
                raise ValueError("La base pertenece a una versión más reciente de Konsora.")
            original.execute("SELECT id FROM projects LIMIT 1")
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd); created.append(target)
            with sqlite3.connect(target) as copied:
                original.backup(copied)
        if key is not None:
            fd = os.open(key_target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            created.append(key_target)
            with os.fdopen(fd, "wb") as stream:
                stream.write(key); stream.flush(); os.fsync(stream.fileno())
        # Las migraciones se aplican únicamente a la copia. No se recorren proyectos.
        with Database(target).connect() as copied:
            count = copied.execute("SELECT count(*) FROM projects").fetchone()[0]
        return {"imported": True, "projects": count, "source_preserved": True, "review_key_preserved": key is not None}
    except BaseException:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise


def diagnostics(directory: Path):
    path = directory / "konsora.sqlite3"
    result = {"protocol": 1, "data_directory_mode": oct(directory.stat().st_mode & 0o777),
              "database_exists": path.is_file(), "bundled_service": bool(getattr(sys, "frozen", False))}
    if path.exists():
        with read_database(path) as connection:
            result.update(schema_version=connection.execute("PRAGMA user_version").fetchone()[0],
                          integrity=connection.execute("PRAGMA quick_check").fetchone()[0],
                          projects=connection.execute("SELECT count(*) FROM projects").fetchone()[0])
    return result
