"""app_state

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_state",
        sa.Column("app_id", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("app_id", name=op.f("pk_app_state")),
    )


def downgrade() -> None:
    op.drop_table("app_state")
