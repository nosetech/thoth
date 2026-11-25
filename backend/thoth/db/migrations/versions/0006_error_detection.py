"""log_cursor / error_event（エラー検知 #16）

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "log_cursor",
        sa.Column("app_id", sa.String(), nullable=False),
        sa.Column("service_id", sa.String(), nullable=False),
        sa.Column("source", sa.Integer(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("inode", sa.Integer(), nullable=False),
        sa.Column("offset", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("app_id", "service_id", "source", name=op.f("pk_log_cursor")),
    )
    op.create_table(
        "error_event",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("app_id", sa.String(), nullable=False),
        sa.Column("service_id", sa.String(), nullable=False),
        sa.Column("rule_id", sa.String(), nullable=False),
        sa.Column("rule_name", sa.String(), nullable=False),
        sa.Column("severity", sa.String(), nullable=False),
        sa.Column("level", sa.String(), nullable=True),
        sa.Column("source", sa.Integer(), nullable=False),
        sa.Column("file_name", sa.String(), nullable=False),
        sa.Column("offset", sa.Integer(), nullable=False),
        sa.Column("line", sa.Text(), nullable=False),
        sa.Column("detected_at", sa.DateTime(), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_error_event")),
    )
    op.create_index("ix_error_event_detected", "error_event", ["detected_at"])
    op.create_index(
        "ix_error_event_service", "error_event", ["app_id", "service_id", "acknowledged_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_error_event_service", table_name="error_event")
    op.drop_index("ix_error_event_detected", table_name="error_event")
    op.drop_table("error_event")
    op.drop_table("log_cursor")
