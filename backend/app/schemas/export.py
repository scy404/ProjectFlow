from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel

from app.schemas.evidence import EvidenceRef
from app.schemas.metrics import ProjectMetricsRead


class ProjectExportType(str, Enum):
    review_summary = "review_summary"
    opc_outcome = "opc_outcome"


class ProjectExportCreate(BaseModel):
    export_type: ProjectExportType


class ExportValidationFact(BaseModel):
    task_id: str
    task_title: str
    result: dict[str, Any]


class ProjectExportFacts(BaseModel):
    generated_at: datetime
    metrics: ProjectMetricsRead
    validation_results: list[ExportValidationFact]
    evidence_refs: list[EvidenceRef]


class ProjectExportRead(BaseModel):
    export_type: ProjectExportType
    markdown: str
    facts: ProjectExportFacts


class ReviewSummaryRead(BaseModel):
    markdown: str
