"""Acceso acotado por descriptores; lecturas sin efectos y escrituras explícitas."""

import fcntl
import hashlib
import hmac
import json
import os
import secrets
import stat
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

from konsora_api.task_document import (
    MAX_DOCUMENT_BYTES, DocumentError, PortableReview, PortableTask, TaskDocument,
    digest, parse_document, serialize_document, task_fingerprint,
)
from konsora_api.workspaces import WorkspaceError, canonical_workspace

NAME = "tasks.json"


class FileStore:
    def __init__(self, workspace: str, key_path: Path):
        self.workspace = Path(workspace)
        self.key_path = key_path

    def revision(self, data: bytes) -> str:
        return digest(str(self.workspace).encode() + b"\0" + data)

    @contextmanager
    def directory(self, *, create: bool = False):
        root_fd = meta_fd = None
        try:
            canonical = canonical_workspace(str(self.workspace))
            if canonical != self.workspace:
                raise HTTPException(409, "La carpeta asociada ha cambiado de destino. Vuelve a seleccionarla.")
            root_fd = os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if create:
                try:
                    os.mkdir(".konsora", 0o700, dir_fd=root_fd)
                    os.fsync(root_fd)
                except FileExistsError:
                    pass
            meta_fd = os.open(".konsora", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            yield meta_fd
        except WorkspaceError as error:
            raise HTTPException(409, str(error)) from error
        except FileNotFoundError:
            if meta_fd is None and not create:
                yield None
            else:
                raise HTTPException(409, "La carpeta o el archivo ya no está disponible.")
        except OSError as error:
            raise HTTPException(409, "No se pudo acceder a .konsora de forma segura. Revisa permisos y enlaces; no se modificaron los datos.") from error
        finally:
            if meta_fd is not None:
                os.close(meta_fd)
            if root_fd is not None:
                os.close(root_fd)

    @staticmethod
    def read_bytes(directory: int | None) -> bytes | None:
        if directory is None:
            return None
        try:
            fd = os.open(NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise HTTPException(409, "El archivo de tareas debe ser regular, sin enlaces simbólicos ni enlaces duros.")
            data = stream.read(MAX_DOCUMENT_BYTES + 1)
            after = os.fstat(stream.fileno())
            if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                raise HTTPException(409, "El archivo cambió durante la lectura. Actualiza el tablero.")
            return data

    def read(self) -> tuple[TaskDocument | None, str | None]:
        try:
            with self.directory() as fd:
                data = self.read_bytes(fd)
            return (parse_document(data), self.revision(data)) if data is not None else (None, None)
        except DocumentError as error:
            raise HTTPException(422, str(error)) from error
        except OSError as error:
            raise HTTPException(409, "No se pudo leer el archivo de tareas de forma segura.") from error

    @contextmanager
    def write(self, expected_revision: str | None, *, initialize: bool = False):
        """Bloqueo cooperativo; el JSON nunca se escribe parcialmente en destino."""
        if not initialize and expected_revision is None:
            raise HTTPException(428, "Actualiza las tareas: falta la huella del archivo que vas a editar.")
        with self.directory(create=initialize) as fd:
            if fd is None:
                raise HTTPException(409, "Falta .konsora/tasks.json. Inicializa o migra las tareas explícitamente.")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                data = self.read_bytes(fd)
                revision = self.revision(data) if data is not None else None
                if initialize and data is not None:
                    raise HTTPException(409, "Ya existe tasks.json. No se sobrescribe; revisa sus tareas o el conflicto de migración.")
                if not initialize and (data is None or revision != expected_revision):
                    raise HTTPException(409, "El archivo cambió externamente. Se conserva tu borrador; actualiza y revisa antes de guardar.")
                document = parse_document(data) if data is not None else TaskDocument(schema_version=1, tasks=[])
                yield document
                output = serialize_document(TaskDocument.model_validate(document.model_dump()))
                current = self.read_bytes(fd)
                if (self.revision(current) if current is not None else None) != revision:
                    raise HTTPException(409, "El archivo cambió mientras editabas. No se ha sobrescrito.")
                self.atomic_write(fd, NAME, output, replace=not initialize)
            except DocumentError as error:
                raise HTTPException(422, str(error)) from error
            except ValidationError as error:
                raise HTTPException(422, "El cambio produciría tareas o historial inválidos. Revisa IDs, dependencias, ciclos y estados.") from error
            except BlockingIOError as error:
                raise HTTPException(409, "Otra operación está guardando este proyecto. Actualiza antes de repetir.") from error
            except OSError as error:
                raise HTTPException(503, "No se pudo guardar el archivo de tareas. Revisa el almacenamiento; actualiza antes de reintentar.") from error
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)

    @staticmethod
    def atomic_write(directory: int, name: str, data: bytes, *, replace: bool):
        temporary = f".konsora-{secrets.token_hex(12)}.tmp"
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            if replace:
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            else:
                os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                os.unlink(temporary, dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass

    def _key(self, *, create: bool = False) -> bytes | None:
        if self.key_path.resolve().is_relative_to(self.workspace):
            if create:
                raise HTTPException(409, "El almacenamiento de Konsora está dentro del proyecto. Configúralo fuera de esta carpeta para proteger la firma de revisión.")
            return None
        try:
            if create:
                try:
                    fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(secrets.token_bytes(32)); stream.flush(); os.fsync(stream.fileno())
                except FileExistsError:
                    pass
            fd = os.open(self.key_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise HTTPException(409, "La clave local de revisión requiere un archivo privado del usuario, sin enlaces.")
                key = stream.read(33)
                if len(key) != 32:
                    raise HTTPException(409, "La clave local de revisión no es válida.")
                return key
        except FileNotFoundError:
            return None
        except OSError as error:
            raise HTTPException(409, "No se pudo comprobar la clave privada de revisión.") from error

    def signature(self, review: PortableReview, key: bytes) -> str:
        value = {"workspace": str(self.workspace), **review.model_dump(mode="json", exclude={"signature"})}
        return hmac.new(key, json.dumps(value, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()

    def accepted(self, task: PortableTask, document: TaskDocument) -> bool:
        if task.status != "done":
            return False
        key = self._key()
        return key is not None and any(review.task_id == task.id and review.fingerprint == task_fingerprint(task) and
            hmac.compare_digest(review.signature, self.signature(review, key)) for review in document.reviews)

    def sign(self, task: PortableTask, document: TaskDocument, timestamp: str):
        key = self._key(create=True)
        if key is None:
            raise HTTPException(409, "No se pudo crear la clave privada de revisión.")
        review = PortableReview(task_id=task.id, fingerprint=task_fingerprint(task), accepted_at=timestamp, signature="0" * 64)
        review.signature = self.signature(review, key)
        document.reviews.append(review)
