"""Proveedores de texto: credenciales solo en el proceso del backend."""

import os
import re
from typing import Protocol

import httpx
from pydantic import BaseModel, SecretStr


class ProviderInfo(BaseModel):
    id: str
    name: str
    available: bool
    models: list[str]
    detail: str


class Generation(BaseModel):
    provider: str
    model: str
    text: str


class ProviderError(Exception):
    """Solo mensajes controlados: nunca cuerpos, cabeceras o errores remotos."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class ModelProvider(Protocol):
    def info(self) -> ProviderInfo: ...

    async def generate(self, model: str, prompt: str, max_output_tokens: int) -> Generation: ...


def check_model(info: ProviderInfo, model: str) -> None:
    if not info.available:
        raise ProviderError(503, "not_configured", info.detail)
    if model not in info.models:
        raise ProviderError(422, "invalid_model", "Selecciona un modelo configurado para este proveedor.")


class MockProvider:
    def info(self) -> ProviderInfo:
        return ProviderInfo(
            id="mock", name="Simulado", available=True, models=["mock-text"],
            detail="Sin conexión a internet, sin credenciales y sin consumo de tokens.",
        )

    async def generate(self, model: str, prompt: str, max_output_tokens: int) -> Generation:
        check_model(self.info(), model)
        return Generation(
            provider="mock", model=model,
            text=f"Respuesta simulada. He recibido tu prompt: {prompt}",
        )


class OpenAIProvider:
    # Destino fijo: ninguna URL de cliente, proxy o variable OPENAI_BASE_URL.
    ENDPOINT = "https://api.openai.com/v1/responses"

    def __init__(
        self, api_key: SecretStr, model: str,
        *, transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._api_key = api_key
        self._model = model
        self._transport = transport

    def info(self) -> ProviderInfo:
        key = self._api_key.get_secret_value()
        valid_key = bool(key) and all(33 <= ord(char) <= 126 for char in key)
        valid_model = bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", self._model))
        if key and key in self._model:
            valid_model = False
        available = valid_key and valid_model
        return ProviderInfo(
            id="openai", name="OpenAI", available=available,
            models=[self._model] if valid_model else [],
            detail=(
                "API configurada. Cada envío consume saldo o créditos de OpenAI."
                if available else
                "Configura OPENAI_API_KEY y KONSORA_OPENAI_MODEL en la terminal del backend y reinícialo."
            ),
        )

    async def generate(self, model: str, prompt: str, max_output_tokens: int) -> Generation:
        check_model(self.info(), model)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(45.0, connect=10.0),
                follow_redirects=False, trust_env=False, transport=self._transport,
            ) as client:
                response = await client.post(
                    self.ENDPOINT,
                    headers={"Authorization": f"Bearer {self._api_key.get_secret_value()}"},
                    json={
                        "model": model, "input": prompt,
                        "max_output_tokens": max_output_tokens, "store": False,
                    },
                )
        except httpx.TimeoutException:
            raise ProviderError(504, "timeout", "OpenAI tardó demasiado en responder. Puedes reintentar; el envío anterior puede haber consumido tokens.") from None
        except httpx.RequestError:
            raise ProviderError(502, "network", "No se pudo conectar con OpenAI. Comprueba tu conexión a internet.") from None

        errors = {
            401: (401, "authentication", "OpenAI rechazó la credencial. Revisa la clave en el backend y reinícialo."),
            403: (403, "permission", "La cuenta no tiene permiso para usar este recurso de OpenAI."),
            404: (422, "model_unavailable", "OpenAI no encuentra el modelo o tu cuenta no tiene acceso a él."),
            429: (429, "rate_limit", "OpenAI ha limitado la petición. Revisa los límites y el saldo de API antes de reintentar."),
            400: (422, "invalid_request", "OpenAI rechazó la petición. Revisa el modelo configurado y el límite de salida."),
        }
        if response.status_code in errors:
            raise ProviderError(*errors[response.status_code])
        if response.status_code != 200:
            raise ProviderError(502, "upstream", "OpenAI no pudo completar la petición. Inténtalo más tarde.")
        try:
            data = response.json()
        except ValueError:
            raise ProviderError(502, "invalid_response", "OpenAI devolvió una respuesta con un formato inesperado.") from None
        if not isinstance(data, dict) or data.get("status") != "completed":
            raise ProviderError(502, "incomplete_response", "OpenAI no completó la respuesta. El límite de salida puede ser insuficiente.")
        output = data.get("output")
        if not isinstance(output, list):
            raise ProviderError(502, "invalid_response", "OpenAI devolvió una respuesta con un formato inesperado.")
        texts = [
            part["text"]
            for item in output if isinstance(item, dict) and item.get("type") == "message"
            and item.get("role") == "assistant" and isinstance(item.get("content"), list)
            for part in item["content"] if isinstance(part, dict)
            and part.get("type") == "output_text" and isinstance(part.get("text"), str)
        ]
        text = "\n".join(texts).strip()
        if not text:
            raise ProviderError(502, "empty_response", "OpenAI no devolvió texto; el modelo puede haber rechazado el prompt.")
        # Defensa adicional ante una respuesta remota que reflejara la credencial.
        text = text.replace(self._api_key.get_secret_value(), "[credencial omitida]")
        return Generation(provider="openai", model=model, text=text)


def configured_providers() -> dict[str, ModelProvider]:
    return {
        "mock": MockProvider(),
        "openai": OpenAIProvider(
            SecretStr(os.environ.get("OPENAI_API_KEY", "").strip()),
            os.environ.get("KONSORA_OPENAI_MODEL", "").strip(),
        ),
    }
