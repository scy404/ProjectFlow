"""Review summary export endpoint."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.export import ReviewSummaryRead
from app.services.export_service import generate_review_summary

router = APIRouter(tags=["export"])


@router.post("/projects/{project_id}/export/review-summary", response_model=ReviewSummaryRead)
def export_review_summary(
    project_id: str,
    session: Annotated[Session, Depends(get_session)],
) -> ReviewSummaryRead:
    try:
        markdown = generate_review_summary(session, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return ReviewSummaryRead(markdown=markdown)
