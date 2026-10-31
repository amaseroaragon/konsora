"""Arranque web de desarrollo con archivo privado de sesión (sin clave en logs)."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "services/api"))
from konsora_api.server import main, private_directory

session = Path(os.environ.get("KONSORA_DEV_SESSION_FILE", root / ".local/dev-session.json"))
private_directory(session.parent)
sys.argv = [sys.argv[0], "--data-dir", str(session.parent / "dev-data"), "--session-file", str(session),
            "--web-origin", f'http://127.0.0.1:{os.environ.get("KONSORA_WEB_PORT", "1420")}']
raise SystemExit(main())
