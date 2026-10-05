import json
from datetime import UTC, datetime

from sqlmodel import Session, select

from app.models import AgentEvent, Project, ProjectResource
from app.models.enums import AgentEventStatus, AgentEventType, TaskKind, TaskStatus
from app.models.task import Task, TaskStatusUpdate
from app.schemas.task import (
    TaskCreate,
    TaskRead,
    TaskUpdate,
    TaskStatusUpdateCreate,
    ValidationResult,
    ValidationResultSubmit,
    ValidationSpec,
)
from app.services.memory_service import validate_viewer


def _json_object(value: str | dict | None) -> dict | None:
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _json_list(value: str | list | None) -> list:
    if not value:
        return []
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def task_to_read(task: Task) -> TaskRead:
    """Convert a task model while keeping legacy rows readable."""
    validation_spec = _json_object(task.validation_spec)
    validation_result = _json_object(task.validation_result)
    return TaskRead(
        id=task.id,
        project_id=task.project_id,
        stage_id=task.stage_id,
        title=task.title,
        description=task.description,
        priority=task.priority,
        status=task.status,
        owner_user_id=task.owner_user_id,
        backup_owner_user_id=task.backup_owner_user_id,
        due_date=task.due_date,
        estimated_hours=task.estimated_hours,
        dependency_ids=_json_list(task.dependency_ids),
        acceptance_criteria=_json_list(task.acceptance_criteria),
        task_kind=getattr(task, "task_kind", TaskKind.delivery.value) or TaskKind.delivery.value,
        validation_spec=ValidationSpec.model_validate(validation_spec) if validation_spec else None,
        validation_result=ValidationResult.model_validate(validation_result) if validation_result else None,
        can_cut=task.can_cut,
        assignment_reason=task.assignment_reason,
        created_by_agent=task.created_by_agent,
        order_index=task.order_index,
        updated_at=task.updated_at,
    )


def create_task(session: Session, data: TaskCreate) -> Task:
    task = Task(
        project_id=data.project_id,
        stage_id=data.stage_id,
        title=data.title,
        description=data.description,
        priority=data.priority.value if hasattr(data.priority, "value") else data.priority,
        due_date=data.due_date.isoformat() if hasattr(data.due_date, "isoformat") else data.due_date,
        estimated_hours=data.estimated_hours,
        can_cut=data.can_cut,
        order_index=data.order_index,
        task_kind=data.task_kind.value,
        validation_spec=(
            json.dumps(data.validation_spec.model_dump(mode="json"), ensure_ascii=False)
            if data.validation_spec else None
        ),
    )
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def get_task(session: Session, task_id: str) -> Task | None:
    return session.get(Task, task_id)


def list_tasks_by_stage(session: Session, stage_id: str) -> list[Task]:
    return list(session.exec(
        select(Task).where(Task.stage_id == stage_id).order_by(Task.order_index, Task.priority, Task.due_date)
    ).all())


def list_tasks_by_project(session: Session, project_id: str) -> list[Task]:
    return list(session.exec(
        select(Task).where(Task.project_id == project_id).order_by(Task.stage_id, Task.order_index, Task.priority, Task.due_date)
    ).all())


def update_task(session: Session, task_id: str, data: TaskUpdate) -> Task:
    task = session.get(Task, task_id)
    if task is None:
        raise ValueError(f"Task {task_id} not found")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if key == "validation_spec":
            value = json.dumps(value, ensure_ascii=False) if value is not None else None
        elif hasattr(value, "value"):
            value = value.value
        setattr(task, key, value)
    if task.task_kind == TaskKind.validation.value and not task.validation_spec:
        raise ValueError("validation tasks require validation_spec")
    task.updated_at = datetime.now(UTC)

    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def record_validation_result(
    session: Session,
    task_id: str,
    data: ValidationResultSubmit,
    *,
    viewer_user_id: str,
) -> Task:
    task = session.get(Task, task_id)
    if task is None:
        raise LookupError("Task not found")
    if task.task_kind != TaskKind.validation.value:
        raise ValueError("only validation tasks accept validation results")

    project = session.get(Project, task.project_id)
    if project is None:
        raise LookupError("Project not found")
    validate_viewer(session, project_id=project.id, viewer_user_id=viewer_user_id)

    evidence_resource_ids = list(dict.fromkeys(data.evidence_resource_ids))
    if evidence_resource_ids:
        resources = session.exec(
            select(ProjectResource).where(ProjectResource.id.in_(evidence_resource_ids))
        ).all()
        resources_by_id = {resource.id: resource for resource in resources}
        invalid_ids = [
            resource_id for resource_id in evidence_resource_ids
            if resource_id not in resources_by_id
            or resources_by_id[resource_id].project_id != task.project_id
        ]
        if invalid_ids:
            raise ValueError("evidence resources must belong to the same project")

    recorded_at = datetime.now(UTC)
    result = ValidationResult(
        summary=data.summary,
        observed_value=data.observed_value,
        decision=data.decision,
        evidence_resource_ids=evidence_resource_ids,
        recorded_by=viewer_user_id,
        recorded_at=recorded_at,
    )
    task.validation_result = json.dumps(result.model_dump(mode="json"), ensure_ascii=False)
    task.updated_at = recorded_at
    session.add(task)

    if data.mark_complete and task.status != TaskStatus.done.value:
        create_status_update(
            session,
            task.id,
            TaskStatusUpdateCreate(
                user_id=viewer_user_id,
                status=TaskStatus.done,
                progress_note=f"提交验证结果：{data.summary}",
            ),
            auto_commit=False,
        )

    event = AgentEvent(
        project_id=project.id,
        workspace_id=project.workspace_id,
        event_type=AgentEventType.validation,
        status=AgentEventStatus.success,
        reasoning_summary="用户提交验证任务结果；未自动修改计划。",
        user_confirmed=True,
    )
    event.set_input_snapshot({
        "task_id": task.id,
        "viewer_user_id": viewer_user_id,
        "mark_complete": data.mark_complete,
    })
    event.set_output_snapshot({
        "task_id": task.id,
        "validation_result": result.model_dump(mode="json"),
        "plan_changed": False,
    })
    session.add(event)
    session.commit()
    session.refresh(task)
    return task


def create_status_update(session: Session, task_id: str, data: TaskStatusUpdateCreate, *, auto_commit: bool = True) -> TaskStatusUpdate:
    # Create the history record
    status_update = TaskStatusUpdate(
        task_id=task_id,
        user_id=data.user_id,
        status=data.status,
        progress_note=data.progress_note,
        blocker=data.blocker,
        available_hours_change=data.available_hours_change,
    )
    session.add(status_update)

    # Also update the Task.status field so the task's current status reflects the change
    task = session.get(Task, task_id)
    if task is not None:
        task.status = data.status.value if hasattr(data.status, "value") else data.status
        task.updated_at = datetime.now(UTC)
        session.add(task)

    # Auto-advance stage if all tasks in the current stage are done
    if task is not None and task.status == "done":
        from app.services.stage_service import try_advance_stage
        try_advance_stage(session, task_id)

    if auto_commit:
        session.commit()
        session.refresh(status_update)
    else:
        session.flush()
    return status_update
