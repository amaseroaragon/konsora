"""Propuestas iniciales independientes, persistidas por participante, solo simuladas."""

import asyncio
import json
import threading
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from konsora_api.connector_routes import local_request
from konsora_api.connectors import AgentConnector, safe_text
from konsora_api.conversations import require_project
from konsora_api.database import Database
from konsora_api.debate_simulators import DebateSimulator

router = APIRouter(
    prefix="/projects/{project_id}/debates", tags=["debates"],
    dependencies=[Depends(local_request)],
)
ProposalStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


class CreateDebate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    problem: str = Field(min_length=1, max_length=16000)
    context: str = Field(default="", max_length=32000)


class StartDebate(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Debate(BaseModel):
    id: UUID
    project_id: UUID
    problem: str
    context: str
    simulated: Literal[True]
    created_at: datetime
    updated_at: datetime


class Proposal(BaseModel):
    id: UUID
    position: Literal[1, 2]
    name: str
    connector: str
    model: str
    simulated: Literal[True]
    status: ProposalStatus
    content: str | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class DebateHistory(BaseModel):
    debate: Debate
    proposals: list[Proposal]


def initial_prompt(problem: str, context: str) -> str:
    prompt = json.dumps({
        "konsora_debate": 1,
        "instruction": "Propón una solución inicial independiente a partir del problema y contexto. Solo texto; sin herramientas ni acceso a otras propuestas.",
        "problem": problem, "context": context,
    }, ensure_ascii=False)
    if len(prompt) > 64000:
        raise HTTPException(422, "El problema y contexto serializados superan el límite de 64000 caracteres.")
    return prompt


class DebateService:
    def __init__(
        self, database: Database, *, participants: tuple[AgentConnector, AgentConnector] | None = None,
        timeout: float = 5.0,
    ):
        self.database = database
        # Registro independiente: nunca se consulta el catálogo de CLIs reales.
        self.participants = participants if participants is not None else (DebateSimulator(1), DebateSimulator(2))
        self.timeout = timeout
        self._recovered = False
        self._recovery_lock = threading.Lock()

    def prepare(self) -> None:
        # Recuperación perezosa: un fallo de SQLite no impide /health. El servicio
        # de desarrollo tiene un solo proceso; no hay trabajos en segundo plano.
        with self._recovery_lock:
            if self._recovered:
                return
            with self.database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                now = datetime.now(UTC).isoformat()
                connection.execute(
                    """UPDATE debates SET updated_at = ? WHERE id IN
                       (SELECT debate_id FROM proposals WHERE status = 'running')""", (now,),
                )
                connection.execute(
                    """UPDATE proposals SET status = 'cancelled', finished_at = ?,
                       error = 'Interrumpida al cerrar o reiniciar el servicio local.' WHERE status = 'running'""",
                    (now,),
                )
            self._recovered = True

    def get(self, project_id: UUID, debate_id: UUID) -> DebateHistory:
        with self.database.connect() as connection:
            connection.execute("BEGIN")
            row = connection.execute(
                "SELECT * FROM debates WHERE id = ? AND project_id = ?",
                (str(debate_id), str(project_id)),
            ).fetchone()
            if row is None:
                raise HTTPException(404, "El debate no existe en este proyecto.")
            proposals = connection.execute(
                "SELECT * FROM proposals WHERE debate_id = ? ORDER BY position ASC", (str(debate_id),),
            ).fetchall()
        return DebateHistory(
            debate=Debate.model_validate(dict(row)),
            proposals=[Proposal.model_validate(dict(item)) for item in proposals],
        )

    def list(self, project_id: UUID) -> list[Debate]:
        with self.database.connect() as connection:
            connection.execute("BEGIN")
            require_project(connection, project_id)
            rows = connection.execute(
                "SELECT * FROM debates WHERE project_id = ? ORDER BY created_at DESC, id ASC", (str(project_id),),
            ).fetchall()
        return [Debate.model_validate(dict(row)) for row in rows]

    def create(self, project_id: UUID, payload: CreateDebate) -> DebateHistory:
        problem, context = safe_text(payload.problem), safe_text(payload.context)
        initial_prompt(problem, context)
        now = datetime.now(UTC).isoformat()
        debate_id = uuid4()
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            require_project(connection, project_id)
            connection.execute(
                "INSERT INTO debates (id, project_id, problem, context, simulated, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
                (str(debate_id), str(project_id), problem, context, now, now),
            )
            for position, letter in ((1, "A"), (2, "B")):
                connection.execute(
                    """INSERT INTO proposals
                       (id, debate_id, position, name, connector, model, simulated, status, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?)""",
                    (str(uuid4()), str(debate_id), position, f"Simulado {letter}",
                     f"mock-debate-{letter.lower()}", f"simulated-{letter.lower()}", now),
                )
            connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, str(project_id)))
        return self.get(project_id, debate_id)

    def finish(
        self, debate_id: UUID, proposal: Proposal, status: ProposalStatus,
        *, content: str | None = None, error: str | None = None,
    ) -> None:
        now = datetime.now(UTC).isoformat()
        with self.database.connect() as connection:
            cursor = connection.execute(
                """UPDATE proposals SET status = ?, content = ?, error = ?, finished_at = ?
                   WHERE id = ? AND debate_id = ? AND status = 'running'""",
                (status, content, error, now, str(proposal.id), str(debate_id)),
            )
            if cursor.rowcount:
                connection.execute("UPDATE debates SET updated_at = ? WHERE id = ?", (now, str(debate_id)))
                connection.execute(
                    "UPDATE projects SET updated_at = ? WHERE id = (SELECT project_id FROM debates WHERE id = ?)",
                    (now, str(debate_id)),
                )

    async def propose(self, debate_id: UUID, proposal: Proposal, connector: AgentConnector, prompt: str) -> None:
        try:
            result = await asyncio.wait_for(connector.send(prompt), timeout=self.timeout)
            if (result.connector != proposal.connector or result.model != proposal.model
                    or not result.text.strip() or len(result.text) > 24000):
                raise ValueError("Respuesta de simulador inválida.")
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            self.finish(debate_id, proposal, "failed", error="El simulador superó el tiempo de espera.")
        except Exception:
            self.finish(debate_id, proposal, "failed", error="El simulador no pudo completar esta propuesta. Las otras propuestas se conservan.")
        else:
            self.finish(debate_id, proposal, "completed", content=safe_text(result.text))

    async def run(self, project_id: UUID, debate_id: UUID, request: Request) -> DebateHistory:
        previous = self.get(project_id, debate_id)
        prompt = initial_prompt(previous.debate.problem, previous.debate.context)
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT status FROM proposals WHERE debate_id = ?", (str(debate_id),)).fetchall()
            if len(rows) != 2 or any(row["status"] != "pending" for row in rows):
                raise HTTPException(409, "Este debate ya se inició. Actualiza el historial o crea otro para repetirlo.")
            now = datetime.now(UTC).isoformat()
            connection.execute("UPDATE proposals SET status = 'running', started_at = ? WHERE debate_id = ?", (now, str(debate_id)))
            connection.execute("UPDATE debates SET updated_at = ? WHERE id = ?", (now, str(debate_id)))

        async def disconnected() -> None:
            while True:
                if (await request.receive())["type"] == "http.disconnect":
                    return

        tasks = [asyncio.create_task(self.propose(debate_id, proposal, connector, prompt))
                 for proposal, connector in zip(previous.proposals, self.participants, strict=True)]
        proposals_done = asyncio.gather(*tasks)
        disconnect = asyncio.create_task(disconnected())
        try:
            done, _ = await asyncio.wait({proposals_done, disconnect}, return_when=asyncio.FIRST_COMPLETED)
            if proposals_done not in done:
                raise HTTPException(499, "Se ha cancelado la simulación. Las propuestas terminadas se conservan.")
            proposals_done.result()
        finally:
            for task in tasks:
                task.cancel()
            disconnect.cancel()
            await asyncio.gather(proposals_done, disconnect, return_exceptions=True)
            # Las escrituras son independientes; nunca se sobrescribe una
            # propuesta ya completada o fallida al cancelar la otra.
            for proposal in previous.proposals:
                self.finish(debate_id, proposal, "cancelled", error="Simulación cancelada; esta propuesta no llegó a terminar.")
        return self.get(project_id, debate_id)


def get_debates(request: Request) -> DebateService:
    service: DebateService = request.app.state.debates
    service.prepare()
    return service


Debates = Annotated[DebateService, Depends(get_debates)]


@router.get("", response_model=list[Debate])
def list_debates(project_id: UUID, service: Debates) -> list[Debate]:
    return service.list(project_id)


@router.post("", response_model=DebateHistory, status_code=201)
def create_debate(project_id: UUID, payload: CreateDebate, service: Debates) -> DebateHistory:
    return service.create(project_id, payload)


@router.get("/{debate_id}", response_model=DebateHistory)
def open_debate(project_id: UUID, debate_id: UUID, service: Debates) -> DebateHistory:
    return service.get(project_id, debate_id)


@router.post("/{debate_id}/run", response_model=DebateHistory)
async def run_debate(
    project_id: UUID, debate_id: UUID, payload: StartDebate, service: Debates, request: Request,
) -> DebateHistory:
    return await service.run(project_id, debate_id, request)
