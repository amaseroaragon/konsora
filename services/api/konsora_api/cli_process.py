"""Procesos propios acotados; no se ejecutan cadenas de shell ni se registran salidas."""

import asyncio
import os
import signal
from dataclasses import dataclass
from pathlib import Path


class ProcessTimeout(Exception):
    pass


class OutputLimit(Exception):
    pass


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes


def cli_environment() -> dict[str, str]:
    # Lista positiva: no pasan API keys, tokens, URLs/proxies ni variables internas
    # de la sesión del agente que haya iniciado Konsora. El CLI gestiona su login.
    names = {
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
        "CODEX_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    }
    return {name: value for name, value in os.environ.items() if name in names}


async def discard_remaining(stream: asyncio.StreamReader) -> None:
    # Tras matar el grupo, las tuberías aún pueden contener datos. Hay que
    # vaciarlas para recibir EOF y liberar el transporte, sin retener la salida.
    while await stream.read(8192):
        pass


async def run_cli(
    args: list[str], *, cwd: Path, input_bytes: bytes = b"", timeout: float = 120,
    output_limit: int = 512 * 1024,
) -> ProcessResult:
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, cwd=cwd, env=cli_environment(), start_new_session=True,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    ))
    try:
        process = await asyncio.shield(spawning)
    except asyncio.CancelledError:
        process = await spawning
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.gather(discard_remaining(process.stdout), discard_remaining(process.stderr), process.wait())
        raise

    async def read(stream: asyncio.StreamReader) -> bytes:
        data = bytearray()
        while chunk := await stream.read(8192):
            data.extend(chunk)
            if len(data) > output_limit:
                raise OutputLimit()
        return bytes(data)

    async def write() -> None:
        try:
            process.stdin.write(input_bytes)
            await process.stdin.drain()
            process.stdin.close()
            await process.stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            pass

    tasks = [
        asyncio.create_task(read(process.stdout)),
        asyncio.create_task(read(process.stderr)),
        asyncio.create_task(write()),
        asyncio.create_task(process.wait()),
    ]
    try:
        stdout, stderr, _, returncode = await asyncio.wait_for(
            asyncio.gather(*tasks), timeout=timeout,
        )
        return ProcessResult(returncode, stdout, stderr)
    except TimeoutError:
        raise ProcessTimeout() from None
    finally:
        # También al cancelar el request o superar la salida: sin descendientes
        # en segundo plano. El grupo pertenece exclusivamente a este proceso.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(discard_remaining(process.stdout), discard_remaining(process.stderr), process.wait())
