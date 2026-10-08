"""Shared helpers that keep integration fixtures portable and time-stable."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import pytest


@dataclass(frozen=True)
class RelativeSchedule:
    """A valid project timeline anchored to the day the test runs."""

    stage_start: str
    cycle_start: str
    task_due: str
    stage_end: str
    project_deadline: str
    replanned_deadline: str


def relative_schedule() -> RelativeSchedule:
    today = date.today()
    return RelativeSchedule(
        stage_start=(today + timedelta(days=1)).isoformat(),
        cycle_start=(today + timedelta(days=5)).isoformat(),
        task_due=(today + timedelta(days=10)).isoformat(),
        stage_end=(today + timedelta(days=15)).isoformat(),
        project_deadline=(today + timedelta(days=30)).isoformat(),
        replanned_deadline=(today + timedelta(days=45)).isoformat(),
    )


def require_symlink_capability(tmp_path: Path) -> None:
    """Skip only when the current host cannot create directory symlinks."""

    target = tmp_path / "symlink-capability-target"
    link = tmp_path / "symlink-capability-link"
    target.mkdir()
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"当前环境未授予创建符号链接的能力: {exc}")
    else:
        link.unlink()
    finally:
        target.rmdir()
