"""Validación de carpetas: no crea, abre para escritura ni recorre archivos."""

import os
import stat
from pathlib import Path
from typing import Literal

WorkspaceStatus = Literal["unassigned", "ready", "missing", "inaccessible", "unsafe"]


class WorkspaceError(Exception):
    def __init__(self, status: WorkspaceStatus, detail: str) -> None:
        self.status = status
        super().__init__(detail)


def canonical_workspace(value: str) -> Path:
    try:
        path = Path(value)
        if not path.is_absolute():
            raise WorkspaceError("unsafe", "Selecciona una ruta absoluta a una carpeta existente.")
        resolved = path.resolve(strict=True)
        mode = resolved.stat().st_mode
        if not stat.S_ISDIR(mode):
            raise WorkspaceError("unsafe", "La ruta seleccionada no es una carpeta.")
        home = Path.home().resolve()
        broad = {Path(p) for p in ("/", "/home", "/root", "/tmp", "/var", "/opt", "/srv", "/mnt", "/media")}
        protected = [Path(p).resolve() for p in ("/etc", "/proc", "/sys", "/dev", "/run", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/snap")]
        protected.extend(home / p for p in (".ssh", ".aws", ".codex", ".config", ".local", ".gnupg"))
        if resolved in broad or resolved == home or resolved in home.parents or any(
            resolved.is_relative_to(root) for root in protected
        ):
            raise WorkspaceError("unsafe", "Selecciona una carpeta de proyecto concreta, fuera de las ubicaciones del sistema o de configuración personal.")
        if not os.access(resolved, os.R_OK | os.W_OK | os.X_OK):
            raise WorkspaceError("inaccessible", "No hay permisos de lectura, escritura o acceso a la carpeta. Revisa los permisos y vuelve a intentarlo.")
        return resolved
    except FileNotFoundError as error:
        raise WorkspaceError("missing", "La carpeta ya no existe o no está disponible. Selecciona otra o vuelve a comprobarla.") from error
    except PermissionError as error:
        raise WorkspaceError("inaccessible", "No se puede acceder a la carpeta. Revisa los permisos y vuelve a intentarlo.") from error
    except (OSError, RuntimeError, ValueError) as error:
        raise WorkspaceError("inaccessible", "No se pudo comprobar la carpeta. Revisa la ruta y vuelve a intentarlo.") from error


def workspace_status(value: str | None) -> WorkspaceStatus:
    if value is None:
        return "unassigned"
    try:
        resolved = canonical_workspace(value)
        # Una carpeta guardada sustituida por un enlace no amplía el alcance.
        return "ready" if str(resolved) == value else "unsafe"
    except WorkspaceError as error:
        return error.status
