"""Autenticación de instancia y límites del cliente HTTP local."""

import secrets
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

LOCAL_ORIGINS = (
    "http://127.0.0.1:1420", "http://localhost:1420",
    "tauri://localhost", "http://tauri.localhost",
)


def development_origin(value: str | None) -> tuple[str, ...]:
    if value is None:
        return LOCAL_ORIGINS
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("Origen de desarrollo no válido.")
    return (*LOCAL_ORIGINS, value)


class LocalSecurityMiddleware:
    def __init__(self, app, *, token: str, port: int, origins=LOCAL_ORIGINS):
        self.app = app
        self.authorization = f"Bearer {token}"
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.origins = frozenset(origins)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = scope.get("headers", [])
        def values(name):
            return [value.decode("latin-1") for key, value in headers if key.lower() == name]
        host, origin, authorization = values(b"host"), values(b"origin"), values(b"authorization")
        peer = scope.get("client")
        valid = (
            peer is not None and peer[0] in {"127.0.0.1", "::1"}
            and len(host) == 1 and host[0].lower() in self.hosts
            and len(origin) == 1 and origin[0] in self.origins
            and len(authorization) == 1
            and secrets.compare_digest(authorization[0].encode("latin-1"), self.authorization.encode())
        )
        if not valid:
            response = JSONResponse({"detail": "Cliente local no autorizado."}, status_code=403,
                                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
            await response(scope, receive, send)
            return
        async def secured_send(message):
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                response_headers.extend([(b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")])
                message = {**message, "headers": response_headers}
            await send(message)
        await self.app(scope, receive, secured_send)
