from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session

from app.core.database import get_session
from app.models.task import Task
from app.schemas.task import (
    TaskCreate,
    TaskUpdate,
    TaskRead,
    TaskStatusUpdateCreate,
    TaskStatusUpdateRead,
    ValidationResultSubmit,
)
from app.services.task_service import (
    create_task,
    get_task,
    list_tasks_by_stage,
    list_tasks_by_project,
    update_task,
    create_status_update,
    record_validation_result,
    task_to_read,
)

router = APIRouter(tags=["tasks"])


def _task_to_read(task: Task) -> TaskRead:
    """Convert a Task model to its read schema, deserializing JSON fields."""
    return task_to_read(task)


@router.post("/tasks", response_model=TaskRead, status_code=201)
def api_create_task(
    data: TaskCreate,
    session: Session = Depends(get_session),
):
    task = create_task(session, data)
    return _task_to_read(task)


@router.get("/tasks/{task_id}", response_model=TaskRead)
def api_get_task(
    task_id: str,
    session: Session = Depends(get_session),
):
    task = get_task(session, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return _task_to_read(task)


@router.get("/stages/{stage_id}/tasks", response_model=list[TaskRead])
def api_list_tasks_by_stage(
    stage_id: str,
    session: Session = Depends(get_session),
):
    tasks = list_tasks_by_stage(session, stage_id)
    return [_task_to_read(t) for t in tasks]


@router.get("/projects/{project_id}/tasks", response_model=list[TaskRead])
def api_list_tasks_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    tasks = list_tasks_by_project(session, project_id)
    return [_task_to_read(t) for t in tasks]


@router.patch("/tasks/{task_id}", response_model=TaskRead)
def api_update_task(
    task_id: str,
    data: TaskUpdate,
    session: Session = Depends(get_session),
):
    try:
        task = update_task(session, task_id, data)
        return _task_to_read(task)
    except ValueError as exc:
        if "not found" in str(exc):
            raise HTTPException(status_code=404, detail="Task not found") from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/tasks/{task_id}/validation-result", response_model=TaskRead)
def api_record_validation_result(
    task_id: str,
    data: ValidationResultSubmit,
    viewer_user_id: str = Query(..., min_length=1, description="当前会话用户 ID"),
    session: Session = Depends(get_session),
):
    try:
        return task_to_read(record_validation_result(
            session,
            task_id,
            data,
            viewer_user_id=viewer_user_id,
        ))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/tasks/{task_id}/status-updates",
    response_model=TaskStatusUpdateRead,
    status_code=201,
)
def api_create_status_update(
    task_id: str,
    data: TaskStatusUpdateCreate,
    session: Session = Depends(get_session),
):
    return create_status_update(session, task_id, data)
