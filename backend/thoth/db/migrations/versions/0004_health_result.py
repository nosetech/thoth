"""health_result

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "health_result",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("app_id", sa.String(), nullable=False),
        sa.Column("service_id", sa.String(), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_health_result")),
    )
    op.create_index(
        "ix_health_result_service",
        "health_result",
        ["app_id", "service_id", "checked_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_health_result_service", table_name="health_result")
    op.drop_table("health_result")
