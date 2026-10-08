"""Guard API success fixtures against calendar-date expiry."""

from __future__ import annotations

import re
from pathlib import Path


SUCCESS_FIXTURE_FILES = (
    "test_checkin_replan_migration.py",
    "test_evaluation_evidence.py",
    "test_memory_retrieval.py",
    "test_output_channel_fix.py",
    "test_replan_memory.py",
    "test_replan_proposal_flow.py",
    "test_retrieval_eval.py",
)
FIXED_BUSINESS_DATE = re.compile(
    r'"(?:deadline|start_date|end_date|due_date)"\s*:\s*"20\d{2}-\d{2}-\d{2}"'
)


def test_success_fixtures_do_not_use_expiring_calendar_dates():
    tests_dir = Path(__file__).parent
    violations: list[str] = []
    for file_name in SUCCESS_FIXTURE_FILES:
        source = (tests_dir / file_name).read_text(encoding="utf-8")
        if FIXED_BUSINESS_DATE.search(source):
            violations.append(file_name)

    assert not violations, (
        "成功场景必须使用 test_support.relative_schedule()；"
        f"发现固定业务日期: {', '.join(violations)}"
    )
