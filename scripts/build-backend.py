"""Empaquetado onedir reproducible, sin crear archivos fuera del repositorio."""

import hashlib
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root / "apps/desktop/src-tauri/resources"
output.mkdir(parents=True, exist_ok=True)
inputs = sorted((root / "services/api/konsora_api").glob("*.py")) + [Path(__file__), root / "services/api/backend_entry.py", root / "services/api/requirements.txt", root / "services/api/requirements-build.txt"]
fingerprint = hashlib.sha256(sys.version.encode() + b"".join(p.read_bytes() for p in inputs)).hexdigest()
stamp = root / ".tools/pyinstaller/fingerprint"
if (output / "backend/backend").is_file() and stamp.exists() and stamp.read_text() == fingerprint:
    raise SystemExit(0)
command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "backend", "--distpath", str(output),
    "--workpath", str(root / ".tools/pyinstaller/work"), "--specpath", str(root / ".tools/pyinstaller"),
    "--paths", str(root / "services/api"), "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops.asyncio", "--hidden-import", "uvicorn.protocols.http.h11_impl",
    "--hidden-import", "uvicorn.lifespan.on", str(root / "services/api/backend_entry.py")]
result = subprocess.call(command, cwd=root, env={**os.environ,
    "PYINSTALLER_CONFIG_DIR": str(root / ".tools/pyinstaller/cache")})
if result == 0:
    stamp.write_text(fingerprint)
raise SystemExit(result)
