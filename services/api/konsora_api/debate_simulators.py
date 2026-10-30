"""Dos participantes deterministas. No dependen de CLIs, redes ni cuentas."""

import asyncio
import json

from konsora_api.connectors import ConnectorInfo, ConnectorModel, PromptResult


class DebateSimulator:
    def __init__(self, position: int, *, delay: float | None = None):
        if position not in (1, 2):
            raise ValueError("El participante debe ser A o B.")
        self.letter = "A" if position == 1 else "B"
        self.id = f"mock-debate-{self.letter.lower()}"
        self.model = f"simulated-{self.letter.lower()}"
        self.delay = delay if delay is not None else (0.4 if position == 1 else 1.5)

    async def info(self) -> ConnectorInfo:
        return ConnectorInfo(
            id=self.id, name=f"Simulado {self.letter}", status="simulated", model=self.model,
            detail="Participante de demostración local, sin inferencia ni consumo de cuota.",
        )

    async def models(self) -> list[ConnectorModel]:
        return []

    async def send(self, prompt: str, *, model: str | None = None) -> PromptResult:
        data = json.loads(prompt)
        await asyncio.sleep(self.delay)
        approach = (
            "Dividir el problema en pasos pequeños y comprobar cada resultado."
            if self.letter == "A" else
            "Comparar alternativas, revisar riesgos y definir criterios de éxito."
        )
        text = (
            f"Propuesta simulada {self.letter}. Es un ejemplo fijo, no una respuesta de IA.\n\n"
            f"Problema recibido: {data['problem']}\n\nEnfoque de ejemplo: {approach}"
        )
        if data["context"]:
            text += f"\n\nContexto recibido (vista previa): {data['context'][:400]}"
        return PromptResult(connector=self.id, model=self.model, text=text)
