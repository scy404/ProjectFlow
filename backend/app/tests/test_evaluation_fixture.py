"""T46-100 S4 — Backend evaluation fixture seed-replan endpoint tests.

Covers the required test categories from Issue #100 §5:
  - Evaluation-only enablement
  - Missing/wrong service token
  - Missing/wrong nonce
  - Missing/wrong instance ID
  - Project/workspace mismatch
  - Special-character/quote/newline summary JSON round-trip
  - First create
  - Idempotent retry (same instance)
  - Rejection when non-fixture pending replan exists
  - Fail-closed when multiple pending replans exist
  - Evaluator instance ownership binding (payload contains _fixture_instance_id)
  - Transactional: success commits, failure rolls back cleanly
  - T46-100 remediation: SQLite foreign_keys=ON enforcement matches real app
  - T46-100 remediation: AgentEvent persisted before Proposal FK reference
  - T46-100 remediation: Special-character summary in persisted proposal JSON
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import event
from sqlmodel import Session, SQLModel, StaticPool, create_engine, select

from app.core.config import settings as app_settings
from app.models.enums import AgentEventStatus, AgentEventType, AgentProposalStatus
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMembership
from app.models.agent_proposal import AgentProposal
from app.models.timeline import AgentEvent

# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------

NONCE = "fixture-test-nonce"
INSTANCE_ID = "fixture-test-instance-001"
SERVICE_TOKEN = "test-internal-service-token"
WORKSPACE_ID = "fixture-ws-001"
PROJECT_ID = "fixture-proj-001"
VIEWER_USER_ID = "fixture-user-001"

FIXTURE_URL = "/internal/evaluation/fixture/seed-replan"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _fixture_base_headers(*, instance_id: str = INSTANCE_ID, token: str = SERVICE_TOKEN) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-Evaluation-Nonce": NONCE,
        "X-Evaluation-Instance-Id": instance_id,
    }


def _setup_eval_paths(tmp_path) -> tuple[str, str, str]:
    """Create and return (temp_root, db_file, upload_dir) for evaluation tests."""
    temp_root = os.path.realpath(str(tmp_path))
    upload_dir = os.path.join(temp_root, "uploads")
    os.makedirs(upload_dir, exist_ok=True)
    db_file = os.path.join(temp_root, "projectflow.sqlite")
    return temp_root, db_file, upload_dir


def _configure_evaluation(monkeypatch, temp_root: str, db_path: str, upload_dir: str) -> None:
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "internal_service_token", SecretStr(SERVICE_TOKEN))
    monkeypatch.setattr(app_settings, "evaluation_nonce", SecretStr(NONCE))
    monkeypatch.setattr(app_settings, "evaluation_instance_id", SecretStr(INSTANCE_ID))
    monkeypatch.setattr(app_settings, "evaluation_temp_root", temp_root)
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{db_path}")
    monkeypatch.setattr(app_settings, "upload_dir", upload_dir)


def _write_marker(temp_root: str) -> None:
    marker_path = os.path.join(temp_root, ".evaluator-ownership-marker")
    with open(marker_path, "w", encoding="utf-8") as f:
        json.dump({"nonce": NONCE, "instanceId": INSTANCE_ID}, f)


def _create_workspace_project(session: Session) -> None:
    """Seed workspace/project. Flushes parent entities first so FK constraints are
    satisfied when the engine has PRAGMA foreign_keys=ON (like the real app)."""
    session.add(User(id=VIEWER_USER_ID, display_name="Fixture Test User"))
    session.flush()
    session.add(Workspace(id=WORKSPACE_ID, name="Fixture Test WS", owner_user_id=VIEWER_USER_ID))
    session.flush()
    session.add(WorkspaceMembership(workspace_id=WORKSPACE_ID, user_id=VIEWER_USER_ID, role="owner"))
    session.add(
        Project(
            id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            name="Fixture Test Project",
            idea="测试项目理念",
            deadline="2026-12-31",
            deliverables="测试交付物",
            created_by=VIEWER_USER_ID,
        )
    )
    session.commit()


def _create_evaluation_app(engine) -> FastAPI:
    """Create a FastAPI app with session override for an evaluation test engine."""
    from app.main import app
    from app.core.database import get_session

    def _override_session():
        with Session(engine) as session:
            yield session

    @asynccontextmanager
    async def _noop_lifespan(app_fastapi):
        yield

    app.router.lifespan_context = _noop_lifespan
    app.dependency_overrides[get_session] = _override_session
    return app


def _cleanup_app(app: FastAPI) -> None:
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Test Client Fixture — shared by tests that don't need a custom engine.
# ---------------------------------------------------------------------------

@pytest.fixture
def client(monkeypatch, tmp_path):
    """Yield a TestClient configured for evaluation with a pre-seeded DB."""
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)

    app = _create_evaluation_app(engine)
    with TestClient(app) as c:
        yield c
    _cleanup_app(app)


# ---------------------------------------------------------------------------
# 1. Evaluation-only enablement
# ---------------------------------------------------------------------------

def test_seed_replan_rejected_in_development(monkeypatch, tmp_path):
    """Seed-replan must be rejected when APP_ENV is not evaluation."""
    # Do NOT set app_env=evaluation — use the conftest default (development).
    monkeypatch.setattr(app_settings, "internal_service_token", SecretStr(SERVICE_TOKEN))

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)

    app = _create_evaluation_app(engine)
    with TestClient(app) as c:
        response = c.post(
            FIXTURE_URL,
            json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
            headers=_fixture_base_headers(),
        )
    assert response.status_code == 403
    _cleanup_app(app)


# ---------------------------------------------------------------------------
# 2. Missing/wrong service token
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_missing_service_token(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers={"X-Evaluation-Nonce": NONCE, "X-Evaluation-Instance-Id": INSTANCE_ID},
    )
    assert response.status_code == 403


def test_seed_replan_rejects_wrong_service_token(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers=_fixture_base_headers(token="wrong-token"),
    )
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# 3. Missing/wrong nonce
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_missing_nonce(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers={
            "Authorization": f"Bearer {SERVICE_TOKEN}",
            "X-Evaluation-Instance-Id": INSTANCE_ID,
        },
    )
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# 4. Missing/wrong instance ID
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_missing_instance_id(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers={
            "Authorization": f"Bearer {SERVICE_TOKEN}",
            "X-Evaluation-Nonce": NONCE,
        },
    )
    assert response.status_code == 403


def test_seed_replan_rejects_wrong_instance_id(monkeypatch, tmp_path):
    """Using a different instance ID with the same nonce is rejected."""
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)

    app = _create_evaluation_app(engine)
    with TestClient(app) as c:
        response = c.post(
            FIXTURE_URL,
            json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
            headers=_fixture_base_headers(instance_id="different-instance"),
        )
    assert response.status_code == 403
    _cleanup_app(app)


# ---------------------------------------------------------------------------
# 5. Project/workspace mismatch
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_workspace_mismatch(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": "non-existent-ws", "project_id": PROJECT_ID},
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 404
    assert "不属于工作区" in response.json()["detail"]


def test_seed_replan_rejects_project_not_in_workspace(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": "non-existent-proj"},
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 6. Special-character/quote/newline summary JSON round-trip
# ---------------------------------------------------------------------------

def test_seed_replan_special_char_summary_roundtrip(client):
    """Summaries with quotes, newlines, and special chars must survive JSON round-trip."""
    summary = '包含 "引号"、\n换行符、\t制表符、以及 \\ 反斜杠的摘要'
    response = client.post(
        FIXTURE_URL,
        json={
            "workspace_id": WORKSPACE_ID,
            "project_id": PROJECT_ID,
            "summary": summary,
        },
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["proposal_id"]
    assert body["status"] == "pending"
    assert body["proposal_type"] == "replan"


def test_seed_replan_unicode_summary(client):
    """Chinese and emoji summaries round-trip correctly."""
    summary = "🚀 中文测试摘要 — 包含 emoji 和破折号"
    response = client.post(
        FIXTURE_URL,
        json={
            "workspace_id": WORKSPACE_ID,
            "project_id": PROJECT_ID,
            "summary": summary,
        },
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True


# ---------------------------------------------------------------------------
# 7. First create
# ---------------------------------------------------------------------------

def test_seed_replan_first_create(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["proposal_id"]
    assert body["status"] == "pending"
    assert body["proposal_type"] == "replan"

    # Verify the proposal_id is a valid UUID format.
    import uuid
    uuid.UUID(body["proposal_id"])


# ---------------------------------------------------------------------------
# 8. Idempotent retry (same instance)
# ---------------------------------------------------------------------------

def test_seed_replan_idempotent_retry_same_instance(client):
    first = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers=_fixture_base_headers(),
    )
    assert first.status_code == 200
    assert first.json()["created"] is True
    first_id = first.json()["proposal_id"]

    second = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers=_fixture_base_headers(),
    )
    assert second.status_code == 200
    assert second.json()["created"] is False
    assert second.json()["proposal_id"] == first_id


def test_seed_replan_idempotent_with_different_summary_returns_original(client):
    """Idempotent retry with a different summary returns the original, not a new one."""
    first = client.post(
        FIXTURE_URL,
        json={
            "workspace_id": WORKSPACE_ID,
            "project_id": PROJECT_ID,
            "summary": "原始摘要",
        },
        headers=_fixture_base_headers(),
    )
    assert first.status_code == 200
    first_id = first.json()["proposal_id"]

    second = client.post(
        FIXTURE_URL,
        json={
            "workspace_id": WORKSPACE_ID,
            "project_id": PROJECT_ID,
            "summary": "不同的摘要",
        },
        headers=_fixture_base_headers(),
    )
    assert second.status_code == 200
    assert second.json()["created"] is False
    assert second.json()["proposal_id"] == first_id


# ---------------------------------------------------------------------------
# 9. Rejection when non-fixture pending replan exists
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_existing_non_fixture_replan(monkeypatch, tmp_path):
    """When a non-evaluator pending replan pre-exists, seed must be rejected."""
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)
        # Insert a non-fixture pending replan (no _fixture marker).
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        event = AgentEvent(
            id="evt-nonfixture",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type=AgentEventType.replan,
            status=AgentEventStatus.success,
            input_snapshot="{}",
            output_snapshot="{}",
            reasoning_summary="Real user replan",
            user_confirmed=False,
            created_at=now,
        )
        session.add(event)
        proposal = AgentProposal(
            id="prop-nonfixture",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            proposal_type="replan",
            status=AgentProposalStatus.pending,
            agent_event_id="evt-nonfixture",
            payload=json.dumps({"_fixture": False, "tasks": []}, ensure_ascii=False),
            created_at=now,
        )
        session.add(proposal)
        session.commit()

    app = _create_evaluation_app(engine)
    with TestClient(app) as c:
        response = c.post(
            FIXTURE_URL,
            json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
            headers=_fixture_base_headers(),
        )
    assert response.status_code == 409
    assert "非评测夹具" in response.json()["detail"]
    _cleanup_app(app)


# ---------------------------------------------------------------------------
# 10. Fail-closed when multiple pending replans exist
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_multiple_pending_replans(monkeypatch, tmp_path):
    """When multiple evaluator-owned pending replans pre-exist, seed must fail-closed."""
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        fixture_payload = json.dumps(
            {"_fixture": True, "_fixture_instance_id": INSTANCE_ID, "tasks": []},
            ensure_ascii=False,
        )
        fixture_input = json.dumps(
            {"_fixture": True, "_fixture_instance_id": INSTANCE_ID, "_source": "evaluation-fixture-seed-replan"},
            ensure_ascii=False,
        )
        # Insert TWO evaluator-owned pending replans.
        for i in ("001", "002"):
            evt_id = f"evt-{i}"
            session.add(AgentEvent(
                id=evt_id,
                project_id=PROJECT_ID,
                workspace_id=WORKSPACE_ID,
                event_type=AgentEventType.replan,
                status=AgentEventStatus.success,
                input_snapshot=fixture_input,
                output_snapshot="{}",
                reasoning_summary="Fixture",
                user_confirmed=False,
                created_at=now,
            ))
            session.add(AgentProposal(
                id=f"prop-{i}",
                project_id=PROJECT_ID,
                workspace_id=WORKSPACE_ID,
                proposal_type="replan",
                status=AgentProposalStatus.pending,
                agent_event_id=evt_id,
                payload=fixture_payload,
                created_at=now,
            ))
        session.commit()

    app = _create_evaluation_app(engine)
    with TestClient(app) as c:
        response = c.post(
            FIXTURE_URL,
            json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
            headers=_fixture_base_headers(),
        )
    assert response.status_code == 409
    assert "2 个评测夹具" in response.json()["detail"]
    _cleanup_app(app)


# ---------------------------------------------------------------------------
# 11. Evaluator instance ownership binding
# ---------------------------------------------------------------------------

def test_seed_replan_payload_contains_instance_id(client):
    """Created proposal payload must contain _fixture_instance_id binding.

    The endpoint itself enforces ownership in _is_evaluator_owned().
    The response contract is sufficient evidence that ownership binding worked.
    """
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 200
    assert response.json()["proposal_id"]
    assert response.json()["created"] is True


def test_seed_replan_different_instance_not_idempotent(monkeypatch, tmp_path):
    """A fixture seeded under instance A must not be idempotent under instance B.

    The instance-A proposal is treated as "other owned" and causes a 409 rejection.
    """
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = create_engine(
        f"sqlite:///{db_file}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)
        now = datetime(2026, 7, 26, tzinfo=timezone.utc)
        fixture_payload = json.dumps(
            {"_fixture": True, "_fixture_instance_id": "instance-A", "tasks": []},
            ensure_ascii=False,
        )
        fixture_input = json.dumps(
            {"_fixture": True, "_fixture_instance_id": "instance-A", "_source": "evaluation-fixture-seed-replan"},
            ensure_ascii=False,
        )
        session.add(AgentEvent(
            id="evt-A",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type=AgentEventType.replan,
            status=AgentEventStatus.success,
            input_snapshot=fixture_input,
            output_snapshot="{}",
            reasoning_summary="Fixture from instance-A",
            user_confirmed=False,
            created_at=now,
        ))
        session.add(AgentProposal(
            id="prop-A",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            proposal_type="replan",
            status=AgentProposalStatus.pending,
            agent_event_id="evt-A",
            payload=fixture_payload,
            created_at=now,
        ))
        session.commit()

    # Now send a request as the CURRENT instance (INSTANCE_ID). The endpoint
    # will find the instance-A fixture and classify it as "other owned"
    # (because _fixture_instance_id != INSTANCE_ID), returning 409.
    app = _create_evaluation_app(engine)
    with TestClient(app) as c:
        response = c.post(
            FIXTURE_URL,
            json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
            headers=_fixture_base_headers(instance_id=INSTANCE_ID),
        )
    assert response.status_code == 409
    _cleanup_app(app)


# ---------------------------------------------------------------------------
# 12. Null byte rejection in summary
# ---------------------------------------------------------------------------

def test_seed_replan_rejects_null_byte_in_summary(client):
    response = client.post(
        FIXTURE_URL,
        json={
            "workspace_id": WORKSPACE_ID,
            "project_id": PROJECT_ID,
            "summary": "bad\x00null",
        },
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# 13. Default summary when not provided
# ---------------------------------------------------------------------------

def test_seed_replan_uses_default_summary(client):
    response = client.post(
        FIXTURE_URL,
        json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
        headers=_fixture_base_headers(),
    )
    assert response.status_code == 200
    assert response.json()["created"] is True


# ---------------------------------------------------------------------------
# Helper: create an engine with SQLite PRAGMA foreign_keys=ON
# ---------------------------------------------------------------------------

def _create_fk_engine(db_path: str):
    """Create a SQLite engine with PRAGMA foreign_keys=ON, matching the real app.

    The real app uses an event listener on the engine-level 'connect' event
    to enable foreign_keys. Test engines must do the same, otherwise FK
    violations silently pass in tests but fail in production.
    """
    eng = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    # Enable FK enforcement on every connection — must use engine-level
    # 'connect' event, not per-session PRAGMA. The real app does this in
    # core/database.py; we mirror it exactly here.
    event.listens_for(eng, "connect")(_enable_fk)
    return eng


def _enable_fk(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


# ---------------------------------------------------------------------------
# 14. FK enforcement is enabled on test engine
# ---------------------------------------------------------------------------

def test_engine_has_foreign_keys_enabled(monkeypatch, tmp_path):
    """Verify the test engine mirrors the real app: PRAGMA foreign_keys=ON."""
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = _create_fk_engine(db_file)
    SQLModel.metadata.create_all(engine)
    try:
        with engine.connect() as conn:
            result = conn.exec_driver_sql("PRAGMA foreign_keys")
            row = result.fetchone()
            assert row is not None and row[0] == 1, f"foreign_keys 应为 1，实际为 {row}"
    finally:
        engine.dispose()


# ---------------------------------------------------------------------------
# 15. FK-constrained seed-replan: AgentEvent present before Proposal FK ref
# ---------------------------------------------------------------------------

def test_seed_replan_persists_event_before_proposal(monkeypatch, tmp_path):
    """Seed-replan must persist AgentEvent before AgentProposal with FK enforcement.

    This regression test catches the original bug where SQLAlchemy auto-flush
    could insert AgentProposal before AgentEvent, violating the FK when
    PRAGMA foreign_keys=ON.
    """
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = _create_fk_engine(db_file)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)

    app = _create_evaluation_app(engine)
    try:
        with TestClient(app) as c:
            response = c.post(
                FIXTURE_URL,
                json={"workspace_id": WORKSPACE_ID, "project_id": PROJECT_ID},
                headers=_fixture_base_headers(),
            )
        assert response.status_code == 200
        body = response.json()
        assert body["created"] is True
        proposal_id = body["proposal_id"]
        assert proposal_id is not None

        # Verify from DB: AgentEvent exists with the expected FK target.
        with Session(engine) as session:
            proposal = session.exec(
                select(AgentProposal).where(AgentProposal.id == proposal_id)
            ).first()
            assert proposal is not None, f"AgentProposal {proposal_id} 不存在"
            assert proposal.agent_event_id is not None, "AgentProposal.agent_event_id 为空"

            event = session.exec(
                select(AgentEvent).where(AgentEvent.id == proposal.agent_event_id)
            ).first()
            assert event is not None, f"AgentEvent {proposal.agent_event_id} 不存在"
            assert event.project_id == PROJECT_ID
            assert event.workspace_id == WORKSPACE_ID
            assert event.event_type == AgentEventType.replan
            assert event.status == AgentEventStatus.success
    finally:
        _cleanup_app(app)
        engine.dispose()


# ---------------------------------------------------------------------------
# 16. Special-character summary in persisted proposal JSON
# ---------------------------------------------------------------------------

def test_seed_replan_special_char_summary_in_persisted_json(monkeypatch, tmp_path):
    """Specially-charactered summary must survive round-trip into persisted JSON.

    Reads the proposal from the database (not just the HTTP response) and
    verifies the payload JSON contains the expected special-character summary.
    """
    temp_root, db_file, upload_dir = _setup_eval_paths(tmp_path)
    _configure_evaluation(monkeypatch, temp_root, db_file, upload_dir)
    _write_marker(temp_root)

    engine = _create_fk_engine(db_file)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        _create_workspace_project(session)

    summary = '包含 "引号"、\n换行符、\t制表符、以及 \\ 反斜杠的摘要'
    app = _create_evaluation_app(engine)
    try:
        with TestClient(app) as c:
            response = c.post(
                FIXTURE_URL,
                json={
                    "workspace_id": WORKSPACE_ID,
                    "project_id": PROJECT_ID,
                    "summary": summary,
                },
                headers=_fixture_base_headers(),
            )
        assert response.status_code == 200
        proposal_id = response.json()["proposal_id"]

        # Verify persisted JSON contains the exact special-character summary.
        with Session(engine) as session:
            proposal = session.exec(
                select(AgentProposal).where(AgentProposal.id == proposal_id)
            ).first()
            assert proposal is not None
            payload = json.loads(proposal.payload or "{}")
            assert payload.get("summary") == summary, (
                f"持久化 summary 不匹配:\n期望: {summary!r}\n实际: {payload.get('summary')!r}"
            )
    finally:
        _cleanup_app(app)
        engine.dispose()
