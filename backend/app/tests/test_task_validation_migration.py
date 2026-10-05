from sqlalchemy import create_engine, inspect, text

from app.core import database


def test_task_validation_migration_preserves_old_rows(monkeypatch, tmp_path):
    db_path = tmp_path / "legacy-task.sqlite"
    migration_engine = create_engine(f"sqlite:///{db_path}")
    with migration_engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                order_index INTEGER NOT NULL DEFAULT 0
            )
        """))
        connection.execute(text("INSERT INTO tasks (id, title) VALUES ('legacy-1', '旧任务')"))

    monkeypatch.setattr(database, "engine", migration_engine)
    monkeypatch.setattr(database.settings, "database_url", f"sqlite:///{db_path}")
    database._migrate_task_validation_fields()
    database._migrate_task_validation_fields()

    columns = {column["name"] for column in inspect(migration_engine).get_columns("tasks")}
    assert {"task_kind", "validation_spec", "validation_result"}.issubset(columns)
    indexes = {index["name"] for index in inspect(migration_engine).get_indexes("tasks")}
    assert "ix_tasks_task_kind" in indexes
    with migration_engine.connect() as connection:
        row = connection.execute(text(
            "SELECT task_kind, validation_spec, validation_result FROM tasks WHERE id='legacy-1'"
        )).one()
    assert row.task_kind == "delivery"
    assert row.validation_spec is None
    assert row.validation_result is None
