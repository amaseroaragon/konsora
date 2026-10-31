"""Servicio privado. El padre entrega la clave por stdin y su EOF detiene el hijo."""

import argparse
import json
import os
import secrets
import socket
import stat
import sqlite3
from contextlib import ExitStack
import sys
import threading
from pathlib import Path

import uvicorn

from konsora_api.main import create_app
from konsora_api.database import StorageError
from konsora_api.maintenance import data_lock, import_registry, diagnostics


def private_directory(path: Path) -> Path:
    path = path.expanduser().absolute()
    if path == Path.home() or path in Path.home().parents:
        raise ValueError("Selecciona un directorio propio de la aplicación.")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or path.is_symlink():
        raise ValueError("Directorio de datos no válido.")
    path.chmod(0o700)
    return path


def write_session(path: Path, value: dict):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush(); os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description="Servicio local privado de Konsora")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--parent-stdin", action="store_true")
    parser.add_argument("--session-file", type=Path)
    parser.add_argument("--web-origin")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--import-registry", type=Path)
    mode.add_argument("--diagnose", action="store_true")
    arguments = parser.parse_args()
    os.umask(0o077)
    lifetime = ExitStack()
    session_file = None
    listener = None
    try:
        data_dir = private_directory(arguments.data_dir)
        lifetime.enter_context(data_lock(data_dir))
        if arguments.import_registry is not None:
            print(json.dumps(import_registry(arguments.import_registry, data_dir)))
            return 0
        if arguments.diagnose:
            print(json.dumps(diagnostics(data_dir)))
            return 0
        if arguments.parent_stdin:
            initial = sys.stdin.buffer.readline(2048)
            value = json.loads(initial)
            token = value["token"]
            if not isinstance(token, str) or len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
                raise ValueError("Sesión local no válida.")
        else:
            token = secrets.token_hex(32)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        app = create_app(data_dir / "konsora.sqlite3", instance_token=token, instance_port=port, web_origin=arguments.web_origin)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False,
            log_level="warning", log_config=None, loop="asyncio", http="h11", ws="none"))
        if arguments.parent_stdin:
            def parent_closed():
                try:
                    while sys.stdin.buffer.read(1):
                        pass
                finally:
                    server.should_exit = True
            threading.Thread(target=parent_closed, daemon=True).start()
        elif arguments.session_file is not None:
            candidate = arguments.session_file.absolute()
            write_session(candidate, {"url": f"http://127.0.0.1:{port}", "token": token, "pid": os.getpid(),
                                      "web_origin": arguments.web_origin or "http://127.0.0.1:1420"})
            session_file = candidate
        else:
            raise ValueError("Indica un padre o un archivo privado de sesión.")
        # Solo información pública de arranque, nunca la credencial.
        print(json.dumps({"protocol": 1, "port": port, "pid": os.getpid()}), flush=True)
        server.run(sockets=[listener])
        return 0
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, StorageError) as error:
        # Mensajes de dominio controlados; no registrar excepciones SQL/rutas/credenciales.
        message = str(error) if isinstance(error, (ValueError, StorageError)) else "Revisa datos, permisos, registro y sesión."
        print(f"No se pudo iniciar Konsora. {message}", file=sys.stderr)
        return 1
    finally:
        lifetime.close()
        if listener is not None:
            listener.close()
        if session_file is not None:
            try:
                session_file.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
