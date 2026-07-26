"""T46-100 S4 Evaluation Fixture API Routes.

Provides evaluator-owned, instance/nonce-bound fixture seeding endpoints:
- POST /internal/evaluation/fixture/seed-replan — pre-seed a pending replan proposal

These endpoints are evaluation-only and require both the sidecar service token
and evaluator instance identity (nonce + instance-id). They are NOT accessible
through the public API and must never be exposed in production.

The fixture seeding is designed as a narrow evaluator seam:
- No arbitrary scripts, SQL, paths, or network targets
- Instance/nonce-bound access control
- Precondition verified via evidence snapshot before SUT execution
- Fixture fingerprint included in scenario/registry integrity
- Deterministic JSON serialization (no string concatenation)
- Workspace/project validation
- Idempotent retry behavior with evaluator-instance ownership binding
- Rejects mixed/multiple/ambiguous pending replan state
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app.core.database import get_session
from app.core.security import require_evaluation_evidence_access
from app.models.agent_proposal import AgentProposal
from app.models.enums import AgentEventStatus, AgentEventType, AgentProposalStatus
from app.models.project import Project
from app.models.timeline import AgentEvent

router = APIRouter(
    prefix="/internal/evaluation/fixture",
    tags=["evaluation-fixture"],
    dependencies=[Depends(require_evaluation_evidence_access)],
)

# Maximum summary length to bound fixture payloads.
MAX_SUMMARY_LENGTH = 500


class SeedReplanRequest(BaseModel):
    """Request to pre-seed a pending replan proposal."""
    workspace_id: str = Field(..., description="Target workspace ID")
    project_id: str = Field(..., description="Target project ID")
    summary: str = Field(
        default="评测夹具预置的计划调整提案",
        max_length=MAX_SUMMARY_LENGTH,
        description="Proposal summary for the pre-seeded replan",
    )

    @field_validator("summary")
    @classmethod
    def summary_must_not_contain_null_bytes(cls, v: str) -> str:
        if "\x00" in v:
            raise ValueError("summary contains null byte")
        return v


class SeedReplanResponse(BaseModel):
    """Response after seeding a pending replan proposal."""
    proposal_id: str
    proposal_type: str = "replan"
    status: str = "pending"
    created: bool


def _validate_project_in_workspace(
    session: Session, workspace_id: str, project_id: str
) -> None:
    """Validate that the project belongs to the workspace. Fail-closed on mismatch."""
    project = session.exec(
        select(Project).where(
            Project.id == project_id,
            Project.workspace_id == workspace_id,
        )
    ).first()
    if project is None:
        raise HTTPException(
            status_code=404,
            detail=f"项目 {project_id} 不属于工作区 {workspace_id} 或不存在",
        )


_FIXTURE_INSTANCE_ID_KEY = "_fixture_instance_id"


def _resolve_evaluation_instance_id(request: Request) -> str:
    """Extract evaluation instance ID from request headers.

    The instance ID comes from X-Evaluation-Instance-Id header, validated
    by require_evaluation_evidence_access before this function is called.
    """
    return request.headers.get("X-Evaluation-Instance-Id", "")


def _is_evaluator_owned(payload: dict, instance_id: str) -> bool:
    """Check if a proposal payload is owned by the current evaluator instance."""
    return (
        payload.get("_fixture") is True
        and payload.get(_FIXTURE_INSTANCE_ID_KEY) == instance_id
    )


@router.post("/seed-replan", response_model=SeedReplanResponse)
def seed_pending_replan(
    body: SeedReplanRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> SeedReplanResponse:
    """Pre-seed a pending replan proposal for evaluation fixture use.

    Creates a pending replan AgentProposal with a minimal synthetic AgentEvent.
    The caller (evaluator runner) must verify the precondition via the evidence
    snapshot before executing the SUT scenario.

    - Validates project belongs to workspace.
    - Uses deterministic JSON serialization (json.dumps, no string concatenation).
    - Ownership is bound to the evaluator instance ID from request headers.
    - Queries ALL pending replans (not just .first()) to detect ambiguous state.
    - Idempotent: if exactly one evaluator-owned pending replan from this
      instance already exists, returns it without creating a duplicate.
    - Rejects if a non-evaluator pending replan, or multiple pending replans,
      exist (409 Conflict).

    This endpoint is evaluation-only; it must never be used in production.
    """
    # Validate project belongs to workspace.
    _validate_project_in_workspace(session, body.workspace_id, body.project_id)

    instance_id = _resolve_evaluation_instance_id(request)

    # Query ALL pending replans for this project/workspace — not just .first().
    # This catches ambiguous state where multiple pending replans exist,
    # which would violate Proposal Uniqueness invariants.
    all_pending = session.exec(
        select(AgentProposal).where(
            AgentProposal.project_id == body.project_id,
            AgentProposal.workspace_id == body.workspace_id,
            AgentProposal.proposal_type == "replan",
            AgentProposal.status == AgentProposalStatus.pending,
        )
    ).all()

    if len(all_pending) > 0:
        evaluator_owned = []
        other_owned = []
        for existing in all_pending:
            try:
                payload = json.loads(existing.payload or "{}")
            except (json.JSONDecodeError, TypeError):
                payload = {}
            if _is_evaluator_owned(payload, instance_id):
                evaluator_owned.append(existing)
            else:
                other_owned.append(existing)

        # Reject mixed ownership: evaluator fixtures must not coexist with
        # real user-created proposals in the same fixture run.
        if other_owned:
            raise HTTPException(
                status_code=409,
                detail="已有非评测夹具创建的 pending replan 提案存在，拒绝覆盖",
            )

        # If exactly one evaluator-owned fixture proposal exists, idempotent return.
        if len(evaluator_owned) == 1:
            return SeedReplanResponse(
                proposal_id=evaluator_owned[0].id,
                proposal_type="replan",
                status="pending",
                created=False,
            )

        # Multiple evaluator-owned proposals — ambiguous state.
        # The runner should not get here; this means the fixture was called
        # multiple times without proper cleanup, or a previous run's fixture
        # leaked. Reject to avoid masking invariants.
        raise HTTPException(
            status_code=409,
            detail=f"存在 {len(evaluator_owned)} 个评测夹具创建的 pending replan，状态异常，拒绝创建新的",
        )

    # Create a minimal synthetic AgentEvent to satisfy the foreign key constraint.
    event_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    fixture_input_snapshot = json.dumps(
        {
            "_fixture": True,
            "_fixture_instance_id": instance_id,
            "_source": "evaluation-fixture-seed-replan",
        },
        ensure_ascii=False,
    )
    fixture_output_snapshot = json.dumps(
        {"_fixture": True, "summary": body.summary},
        ensure_ascii=False,
    )
    agent_event = AgentEvent(
        id=event_id,
        project_id=body.project_id,
        workspace_id=body.workspace_id,
        event_type=AgentEventType.replan,
        status=AgentEventStatus.success,
        input_snapshot=fixture_input_snapshot,
        output_snapshot=fixture_output_snapshot,
        reasoning_summary="评测夹具预置：等待后续 SUT 重复 replan 测试",
        user_confirmed=False,
        created_at=now,
    )
    session.add(agent_event)
    # Flush the AgentEvent to the database before adding the AgentProposal
    # that references it via `agent_event_id`. Without explicit flush,
    # SQLAlchemy's auto-flush may attempt to insert the proposal first,
    # violating the FOREIGN KEY constraint when SQLite PRAGMA foreign_keys=ON.
    try:
        session.flush([agent_event])
    except Exception:
        session.rollback()
        raise HTTPException(
            status_code=500,
            detail="评测夹具创建失败：无法持久化关联事件",
        )

    proposal_id = str(uuid.uuid4())
    fixture_payload = json.dumps(
        {
            "_fixture": True,
            "_fixture_instance_id": instance_id,
            "summary": body.summary,
            "tasks": [],
        },
        ensure_ascii=False,
    )
    proposal = AgentProposal(
        id=proposal_id,
        project_id=body.project_id,
        workspace_id=body.workspace_id,
        proposal_type="replan",
        status=AgentProposalStatus.pending,
        agent_event_id=event_id,
        payload=fixture_payload,
        created_at=now,
    )
    session.add(proposal)
    try:
        session.commit()
    except Exception:
        session.rollback()
        raise HTTPException(
            status_code=500,
            detail="评测夹具创建失败：无法持久化提案",
        )

    return SeedReplanResponse(
        proposal_id=proposal_id,
        proposal_type="replan",
        status="pending",
        created=True,
    )
