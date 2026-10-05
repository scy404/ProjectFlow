from datetime import date, datetime
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import TaskKind, TaskPriority, TaskStatus, ValidationDecision
from app.schemas.common import NonEmptyStr


class ValidationSpec(BaseModel):
    hypothesis: NonEmptyStr
    method: NonEmptyStr
    success_criterion: NonEmptyStr
    sample_target: int | None = Field(default=None, ge=1)


class ValidationResult(BaseModel):
    summary: NonEmptyStr
    observed_value: NonEmptyStr
    decision: ValidationDecision
    evidence_resource_ids: list[str] = Field(default_factory=list)
    recorded_by: NonEmptyStr
    recorded_at: datetime


class TaskCreate(BaseModel):
    project_id: NonEmptyStr
    stage_id: NonEmptyStr
    title: NonEmptyStr
    description: NonEmptyStr
    priority: TaskPriority = TaskPriority.P1
    due_date: date
    estimated_hours: float = Field(default=0.0, ge=0)
    can_cut: bool = False
    order_index: int = 0
    task_kind: TaskKind = TaskKind.delivery
    validation_spec: ValidationSpec | None = None

    @model_validator(mode="after")
    def require_validation_spec(self) -> "TaskCreate":
        if self.task_kind == TaskKind.validation and self.validation_spec is None:
            raise ValueError("validation tasks require validation_spec")
        return self


class TaskUpdate(BaseModel):
    title: NonEmptyStr | None = None
    description: NonEmptyStr | None = None
    priority: TaskPriority | None = None
    status: TaskStatus | None = None
    owner_user_id: NonEmptyStr | None = None
    can_cut: bool | None = None
    task_kind: TaskKind | None = None
    validation_spec: ValidationSpec | None = None


class TaskRead(BaseModel):
    id: str
    project_id: str
    stage_id: str
    title: str
    description: str
    priority: TaskPriority
    status: TaskStatus
    owner_user_id: str | None
    backup_owner_user_id: str | None
    due_date: date
    estimated_hours: float
    dependency_ids: list[str]
    acceptance_criteria: list[str]
    task_kind: TaskKind = TaskKind.delivery
    validation_spec: ValidationSpec | None = None
    validation_result: ValidationResult | None = None
    can_cut: bool
    assignment_reason: str | None
    created_by_agent: bool
    order_index: int
    updated_at: datetime


class ValidationResultSubmit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: NonEmptyStr
    observed_value: NonEmptyStr
    decision: ValidationDecision
    evidence_resource_ids: list[NonEmptyStr] = Field(default_factory=list)
    mark_complete: bool = False


class TaskStatusUpdateCreate(BaseModel):
    user_id: NonEmptyStr
    status: TaskStatus
    progress_note: NonEmptyStr | None = None
    blocker: NonEmptyStr | None = None
    available_hours_change: float | None = None


class TaskStatusUpdateRead(BaseModel):
    id: str
    task_id: str
    user_id: str
    status: TaskStatus
    progress_note: str | None
    blocker: str | None
    available_hours_change: float | None
    created_at: datetime
