from datetime import UTC, datetime

from sqlmodel import Session, select

from app.models import (
    ActionCard,
    AgentEvent,
    AgentProposal,
    AssignmentProposal,
    Project,
    Risk,
    Task,
)
from app.models.enums import AgentEventStatus, AgentEventType, AgentProposalStatus
from app.schemas.metrics import CountRatio, ProjectMetricsRead


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def get_project_metrics(session: Session, project_id: str) -> ProjectMetricsRead:
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError("Project not found")

    proposals = list(
        session.exec(
            select(AgentProposal).where(AgentProposal.project_id == project_id)
        ).all()
    )
    assignments = list(
        session.exec(
            select(AssignmentProposal).where(
                AssignmentProposal.project_id == project_id
            )
        ).all()
    )
    tasks = list(session.exec(select(Task).where(Task.project_id == project_id)).all())
    risks = list(session.exec(select(Risk).where(Risk.project_id == project_id)).all())
    action_cards = list(
        session.exec(
            select(ActionCard).where(ActionCard.project_id == project_id)
        ).all()
    )
    first_plan = session.exec(
        select(AgentEvent)
        .where(
            AgentEvent.project_id == project_id,
            AgentEvent.event_type == AgentEventType.plan,
            AgentEvent.user_confirmed.is_(True),
            AgentEvent.status.in_(
                [
                    AgentEventStatus.success,
                    AgentEventStatus.repaired,
                    AgentEventStatus.fallback,
                ]
            ),
        )
        .order_by(AgentEvent.created_at)
    ).first()

    confirmed = sum(p.status == AgentProposalStatus.confirmed for p in proposals)
    rejected = sum(p.status == AgentProposalStatus.rejected for p in proposals)
    pending = sum(p.status == AgentProposalStatus.pending for p in proposals)
    completed_assignments = sum(a.status == "finalized" for a in assignments)
    completed_tasks = sum(t.status == "done" for t in tasks)
    validation_tasks = [t for t in tasks if (t.task_kind or "delivery") == "validation"]
    validation_with_result = sum(bool(t.validation_result) for t in validation_tasks)

    created_at = _as_utc(project.created_at)
    first_plan_at = _as_utc(first_plan.created_at) if first_plan else None
    elapsed = (
        max(0, int((first_plan_at - created_at).total_seconds()))
        if first_plan_at
        else None
    )

    return ProjectMetricsRead(
        project_id=project_id,
        project_created_at=project.created_at,
        first_confirmed_plan_at=first_plan.created_at if first_plan else None,
        created_to_first_plan_seconds=elapsed,
        proposals_total=len(proposals),
        proposals_confirmed=confirmed,
        proposals_rejected=rejected,
        proposals_pending=pending,
        proposal_decision_ratio=CountRatio(
            numerator=confirmed + rejected,
            denominator=len(proposals),
        ),
        assignments_completed=completed_assignments,
        assignments_total=len(assignments),
        assignment_completion_ratio=CountRatio(
            numerator=completed_assignments,
            denominator=len(assignments),
        ),
        tasks_total=len(tasks),
        tasks_completed=completed_tasks,
        task_completion_ratio=CountRatio(
            numerator=completed_tasks,
            denominator=len(tasks),
        ),
        validation_tasks_total=len(validation_tasks),
        validation_tasks_with_result=validation_with_result,
        validation_conclusion_ratio=CountRatio(
            numerator=validation_with_result,
            denominator=len(validation_tasks),
        ),
        risks_total=len(risks),
        action_cards_total=len(action_cards),
        calculation_notes={
            "created_to_first_plan_seconds": "项目创建时间到首个已确认、且非失败的计划事件之间的秒数。",
            "proposal_decision_ratio": "已确认或已拒绝的 Agent Proposal 数 / Proposal 总数。",
            "assignment_completion_ratio": "状态为 finalized 的分工建议数 / 分工建议总数。",
            "task_completion_ratio": "状态为 done 的任务数 / 任务总数。",
            "validation_conclusion_ratio": "已持久化 validation_result 的验证任务数 / 验证任务总数。",
        },
    )
