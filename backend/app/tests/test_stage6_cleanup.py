from fastapi.testclient import TestClient

from app.api import routes_export


def test_legacy_export_route_delegates_to_unified_service(
    client: TestClient,
    monkeypatch,
) -> None:
    calls: list[str] = []

    def fake_generate_review_summary(_session, project_id: str) -> str:
        calls.append(project_id)
        return "# unified export"

    monkeypatch.setattr(
        routes_export,
        "generate_review_summary",
        fake_generate_review_summary,
    )

    response = client.post("/api/projects/project-stage6/export/review-summary")

    assert response.status_code == 200
    assert response.json() == {"markdown": "# unified export"}
    assert calls == ["project-stage6"]
