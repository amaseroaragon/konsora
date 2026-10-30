"""SQLite local con migraciones versionadas y transacciones por operación."""

import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = (
    (
        """CREATE TABLE projects (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""",
    ),
    (
        """CREATE TABLE conversations (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
            connector TEXT NOT NULL,
            model TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        "CREATE INDEX conversations_project ON conversations(project_id, created_at, id)",
        """CREATE TABLE messages (
            id TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position > 0),
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            connector TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(conversation_id, position)
        )""",
    ),
    (
        """CREATE TABLE debates (
            id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            problem TEXT NOT NULL CHECK (length(trim(problem)) BETWEEN 1 AND 16000),
            context TEXT NOT NULL,
            simulated INTEGER NOT NULL CHECK (simulated = 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""",
        "CREATE INDEX debates_project ON debates(project_id, created_at, id)",
        """CREATE TABLE proposals (
            id TEXT PRIMARY KEY NOT NULL,
            debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position IN (1, 2)),
            name TEXT NOT NULL,
            connector TEXT NOT NULL,
            model TEXT NOT NULL,
            simulated INTEGER NOT NULL CHECK (simulated = 1),
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
            content TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            UNIQUE(debate_id, position),
            CHECK ((status = 'completed' AND content IS NOT NULL AND error IS NULL)
                OR (status IN ('failed', 'cancelled') AND content IS NULL AND error IS NOT NULL)
                OR (status IN ('pending', 'running') AND content IS NULL AND error IS NULL))
        )""",
    ),
    (
        "ALTER TABLE projects ADD COLUMN workspace_path TEXT",
    ),
)


class StorageError(Exception):
    """Error recuperable de almacenamiento, sin reconstrucción de datos."""


def default_database_path() -> Path:
    configured = os.environ.get("KONSORA_DATABASE_PATH")
    path = Path(configured).expanduser() if configured else Path(".local/konsora.sqlite3")
    return path if path.is_absolute() else REPOSITORY_ROOT / path


class Database:
    def __init__(self, path: Path, *, timeout: float = 1.0) -> None:
        self.path = path
        self.timeout = timeout

    def _migrate(self, connection: sqlite3.Connection) -> None:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > len(MIGRATIONS):
            raise StorageError(
                "La base de datos pertenece a una versión más reciente de Konsora. "
                "Abre el proyecto con esa versión."
            )
        if version == len(MIGRATIONS):
            return

        # Las sentencias y user_version se confirman juntas. No se utiliza
        # executescript, que puede confirmar una transacción pendiente.
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > len(MIGRATIONS):
                raise StorageError("La base de datos requiere una versión más reciente de Konsora.")
            for index in range(version, len(MIGRATIONS)):
                for statement in MIGRATIONS[index]:
                    connection.execute(statement)
                connection.execute(f"PRAGMA user_version = {index + 1}")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=self.timeout)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            self._migrate(connection)
            with connection:
                yield connection
        except (OSError, sqlite3.Error) as error:
            raise StorageError(
                "No se pudo acceder al almacenamiento local. "
                "Comprueba que esté disponible y vuelve a intentarlo."
            ) from error
        finally:
            if connection is not None:
                connection.close()
