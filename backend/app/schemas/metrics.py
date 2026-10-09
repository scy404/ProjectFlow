from datetime import datetime

from pydantic import BaseModel, Field


class CountRatio(BaseModel):
    numerator: int = Field(ge=0)
    denominator: int = Field(ge=0)


class ProjectMetricsRead(BaseModel):
    project_id: str
    project_created_at: datetime
    first_confirmed_plan_at: datetime | None
    created_to_first_plan_seconds: int | None = Field(default=None, ge=0)
    proposals_total: int = Field(ge=0)
    proposals_confirmed: int = Field(ge=0)
    proposals_rejected: int = Field(ge=0)
    proposals_pending: int = Field(ge=0)
    proposal_decision_ratio: CountRatio
    assignments_completed: int = Field(ge=0)
    assignments_total: int = Field(ge=0)
    assignment_completion_ratio: CountRatio
    tasks_total: int = Field(ge=0)
    tasks_completed: int = Field(ge=0)
    task_completion_ratio: CountRatio
    validation_tasks_total: int = Field(ge=0)
    validation_tasks_with_result: int = Field(ge=0)
    validation_conclusion_ratio: CountRatio
    risks_total: int = Field(ge=0)
    action_cards_total: int = Field(ge=0)
    calculation_notes: dict[str, str]
