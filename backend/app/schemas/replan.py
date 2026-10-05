from datetime import date
from typing import Any

from pydantic import BaseModel, Field

from app.models.enums import TaskStatus
from app.schemas.action_card import ActionCardCreate
from app.schemas.common import NonEmptyStr
from app.schemas.evidence import EvidenceRef


class ReplanStageAdjustment(BaseModel):
    stage_id: NonEmptyStr
    new_start_date: date | None = None
    new_end_date: date | None = None
    reason: NonEmptyStr


class ReplanTaskChange(BaseModel):
    task_id: NonEmptyStr
    title: NonEmptyStr | None = None
    status: TaskStatus | None = None
    owner_user_id: NonEmptyStr | None = None
    due_date: date | None = None
    can_cut: bool | None = None
    reason: NonEmptyStr
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)


class ReplanConfirmRequest(BaseModel):
    project_id: NonEmptyStr
    before: dict[str, Any] | list | str
    after: dict[str, Any] | list | str
    impact: NonEmptyStr
    reason: NonEmptyStr
    requires_confirmation: bool
    stage_adjustments: list[ReplanStageAdjustment] = Field(default_factory=list)
    task_changes: list[ReplanTaskChange] = Field(default_factory=list)
    action_cards: list[ActionCardCreate] = Field(default_factory=list)


class ReplanConfirmRead(BaseModel):
    confirmed: bool
    project_id: str
    before: dict[str, Any] | list | str
    after: dict[str, Any] | list | str
    impact: str
    reason: str
    requires_confirmation: bool
    applied_stage_ids: list[str]
    applied_task_ids: list[str]
    created_action_card_ids: list[str]
