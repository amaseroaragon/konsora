"""Conectores oficiales de suscripción. Konsora nunca lee el almacén de tokens."""

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal, Protocol

from pydantic import BaseModel

from konsora_api.cli_process import OutputLimit, ProcessTimeout, run_cli

ROOT = Path(__file__).resolve().parents[3]
ConnectorStatus = Literal["ready", "simulated", "missing", "login_required", "api_login", "unsupported", "error"]


class ConnectorInfo(BaseModel):
    id: str
    name: str
    status: ConnectorStatus
    model: str
    detail: str


class PromptResult(BaseModel):
    connector: str
    model: str
    text: str


class ConnectorError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class AgentConnector(Protocol):
    async def info(self) -> ConnectorInfo: ...

    async def send(self, prompt: str) -> PromptResult: ...


class MockConnector:
    async def info(self) -> ConnectorInfo:
        return ConnectorInfo(
            id="mock", name="Simulado", status="simulated", model="Simulado local",
            detail="Sin internet, sin iniciar un CLI y sin consumir cuota.",
        )

    async def send(self, prompt: str) -> PromptResult:
        return PromptResult(connector="mock", model="Simulado local", text=f"Respuesta simulada: {prompt}")


def safe_text(text: str) -> str:
    # No se inspeccionan tokens reales para ocultarlos. Se descartan formatos de
    # credenciales conocidos si aparecieran en una respuesta del propio modelo.
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}", "[credencial omitida]", text)
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9_.-]+", "Bearer [credencial omitida]", text)
    return re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[credencial omitida]", text)


def cli_failure(diagnostics: str) -> ConnectorError:
    # Solo se clasifica; jamás se devuelve el diagnóstico original.
    lowered = diagnostics.lower()
    if any(word in lowered for word in ("unauthorized", "authentication", "not logged", "401", "sign in", "refresh token")):
        return ConnectorError(401, "authentication", "Codex necesita una sesión de ChatGPT válida. Ejecuta codex login en tu terminal.")
    if any(word in lowered for word in ("usage limit", "rate limit", "quota", "429", "credits")):
        return ConnectorError(429, "quota", "Codex ha alcanzado un límite de uso. Revisa tu cuota de ChatGPT antes de reintentar.")
    if any(word in lowered for word in ("network", "connect", "dns", "stream disconnected", "websocket")):
        return ConnectorError(502, "network", "Codex no pudo conectar con el servicio. Comprueba tu conexión y reintenta.")
    return ConnectorError(502, "cli_failed", "Codex no pudo completar la consulta. Revisa su instalación y sesión en la terminal.")


class CodexCLIConnector:
    def __init__(
        self, binary: str | None = None, model: str | None = None,
        workspace_root: Path | None = None, timeout: float = 120,
    ):
        self._binary = binary or os.environ.get("KONSORA_CODEX_BIN", "codex")
        self._model = model if model is not None else os.environ.get("KONSORA_CODEX_MODEL", "")
        self._workspace_root = workspace_root or ROOT / ".local" / "codex"
        self._timeout = timeout
        self._busy = asyncio.Lock()

    @property
    def model(self) -> str:
        return safe_text(self._model) if self._model else "Predeterminado de Codex"

    def executable(self) -> str | None:
        return shutil.which(self._binary)

    def status_info(self, status: ConnectorStatus, detail: str) -> ConnectorInfo:
        return ConnectorInfo(id="codex", name="Codex CLI", status=status, model=self.model, detail=detail)

    async def info(self) -> ConnectorInfo:
        binary = self.executable()
        if binary is None:
            return self.status_info("missing", "No se encuentra Codex CLI. Instálalo desde la documentación oficial y reinicia el servicio local.")
        if self._model and (
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", self._model)
            or safe_text(self._model) != self._model
        ):
            return self.status_info("unsupported", "El modelo configurado no es válido. Revisa KONSORA_CODEX_MODEL en el backend.")
        try:
            version = await run_cli([binary, "--version"], cwd=ROOT, timeout=8)
            match = re.fullmatch(rb"codex-cli (\d+)\.(\d+)\.(\d+)(?:[^\r\n]*)\s*", version.stdout)
            if version.returncode or not match or tuple(int(part) for part in match.groups()[:2]) != (0, 165):
                return self.status_info("unsupported", "Esta integración está validada con Codex CLI 0.165.x. Otras versiones requieren comprobar sus opciones de aislamiento.")
            login = await run_cli([binary, "login", "status"], cwd=ROOT, timeout=8)
        except (OSError, ProcessTimeout, OutputLimit):
            return self.status_info("error", "No se pudo consultar Codex CLI. Comprueba la instalación y vuelve a intentarlo.")
        output = (login.stdout + login.stderr).decode("utf-8", errors="replace")
        if login.returncode == 0 and output.strip() == "Logged in using ChatGPT":
            return self.status_info("ready", "Sesión de ChatGPT detectada. Cada envío utiliza los límites de tu suscripción.")
        if login.returncode == 0 and "api key" in output.lower():
            return self.status_info("api_login", "La sesión usa API. Konsora solo permite ChatGPT: cambia el login mediante codex login en tu terminal.")
        return self.status_info("login_required", "Inicia sesión con ChatGPT ejecutando codex login en tu terminal; después actualiza el estado.")

    def command(self, binary: str, workspace: Path) -> list[str]:
        args = [
            binary, "exec", "--ignore-user-config", "--ephemeral",
            "--json", "--color", "never", "--sandbox", "read-only",
            "--skip-git-repo-check", "--cd", str(workspace),
        ]
        settings = {
            "forced_login_method": '"chatgpt"', "model_provider": '"openai"',
            "approval_policy": '"never"', "web_search": '"disabled"',
            "project_doc_max_bytes": "0", "agents.enabled": "false",
            "history.persistence": '"none"', "analytics.enabled": "false",
            "feedback.enabled": "false", "otel.log_user_prompt": "false",
            "developer_instructions": json.dumps(
                "Responde al prompt como consulta de texto. No uses herramientas, "
                "no leas archivos, no ejecutes comandos y no modifiques datos."
            ),
        }
        for name, value in settings.items():
            args.extend(["-c", f"{name}={value}"])
        for feature in (
            "shell_tool", "shell_snapshot", "code_mode", "code_mode_host", "plugins",
            "apps", "hooks", "multi_agent", "computer_use", "in_app_browser",
            "image_generation", "view_image", "memories", "sleep_tool", "tool_suggest",
            "unbounded_connection_retries",
        ):
            args.extend(["--disable", feature])
        if self._model:
            args.extend(["--model", self._model])
        return [*args, "-"]

    async def send(self, prompt: str) -> PromptResult:
        if self._busy.locked():
            raise ConnectorError(409, "busy", "Codex ya está atendiendo una consulta. Espera a que termine.")
        async with self._busy:
            info = await self.info()
            if info.status != "ready":
                raise ConnectorError(503, info.status, info.detail)
            binary = self.executable()
            if binary is None:
                raise ConnectorError(503, "missing", "Codex CLI ya no está disponible.")
            try:
                self._workspace_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                with TemporaryDirectory(prefix="prompt-", dir=self._workspace_root) as directory:
                    workspace = Path(directory)
                    # Evita heredar la configuración de un proyecto padre.
                    (workspace / ".git").mkdir()
                    result = await run_cli(
                        self.command(binary, workspace), cwd=workspace,
                        input_bytes=prompt.encode("utf-8"), timeout=self._timeout,
                    )
            except ProcessTimeout:
                raise ConnectorError(504, "timeout", "Codex tardó demasiado. Se ha detenido el proceso; la consulta puede haber consumido cuota.") from None
            except OutputLimit:
                raise ConnectorError(502, "output_limit", "Codex superó el límite de salida y se ha detenido.") from None
            except OSError:
                raise ConnectorError(503, "process", "No se pudo iniciar Codex o preparar su directorio aislado.") from None
            if result.returncode:
                raise cli_failure((result.stdout + result.stderr).decode("utf-8", errors="replace"))
            return self.parse_output(result.stdout)

    def parse_output(self, output: bytes) -> PromptResult:
        texts: list[str] = []
        completed = False
        try:
            for line in output.splitlines():
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError()
                kind = event.get("type")
                if kind in {"error", "turn.failed"}:
                    raise cli_failure(json.dumps(event))
                if kind == "turn.completed":
                    completed = True
                if kind in {"item.started", "item.completed"}:
                    item = event.get("item")
                    if not isinstance(item, dict):
                        raise ValueError()
                    # El CLI también emite diagnósticos no fatales como items
                    # error, incluso antes de turn.started. No son herramientas
                    # ni respuestas: se omiten y se exige turn.completed al final.
                    if item.get("type") not in {"agent_message", "reasoning", "plan", "error"}:
                        raise ConnectorError(502, "unexpected_tool", "El CLI notificó una herramienta inesperada. La consulta se ha rechazado; no se amplían permisos.")
                    if kind == "item.completed" and item.get("type") == "agent_message":
                        if not isinstance(item.get("text"), str):
                            raise ValueError()
                        texts.append(item["text"])
        except (ValueError, UnicodeDecodeError):
            raise ConnectorError(502, "invalid_output", "La salida de Codex no tiene el formato esperado.") from None
        text = "\n".join(texts).strip()
        if not completed or not text:
            raise ConnectorError(502, "incomplete", "Codex no completó una respuesta de texto. Puedes revisar su sesión y reintentar.")
        return PromptResult(connector="codex", model=self.model, text=safe_text(text))


def configured_connectors() -> dict[str, AgentConnector]:
    return {"mock": MockConnector(), "codex": CodexCLIConnector()}
