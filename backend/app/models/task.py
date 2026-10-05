import uuid
from datetime import datetime, timezone

from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Text


class Task(SQLModel, table=True):
    __tablename__ = "tasks"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    stage_id: str = Field(foreign_key="stages.id", index=True)
    title: str
    description: str = Field(default="")
    priority: str = Field(default="P1")  # "P0" | "P1" | "P2"
    status: str = Field(default="not_started", index=True)  # "not_started" | "in_progress" | "done" | "blocked"
    owner_user_id: str | None = Field(default=None, foreign_key="users.id", index=True)
    backup_owner_user_id: str | None = Field(default=None, foreign_key="users.id")
    due_date: str = Field(default="")  # ISO date string
    estimated_hours: float = Field(default=0.0)
    dependency_ids: str = Field(default="[]")  # JSON string: ["task_id1", ...]
    acceptance_criteria: str = Field(default="[]")  # JSON string: ["criterion1", ...]
    task_kind: str = Field(default="delivery", index=True)
    validation_spec: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    validation_result: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    can_cut: bool = Field(default=False)
    assignment_reason: str | None = Field(default=None)
    order_index: int = Field(default=0)
    created_by_agent: bool = Field(default=False)
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class TaskStatusUpdate(SQLModel, table=True):
    __tablename__ = "task_status_updates"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    task_id: str = Field(foreign_key="tasks.id", index=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    status: str  # "not_started" | "in_progress" | "done" | "blocked"
    progress_note: str | None = Field(default=None)
    blocker: str | None = Field(default=None)
    available_hours_change: float | None = Field(default=None)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
