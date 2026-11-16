"""initial

Revision ID: 0001
Revises:
Create Date: 2026-11-16
"""

import sqlalchemy as sa
from alembic import op

from thoth.db.models import UtcDateTime

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schema_info",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(), nullable=False),
        sa.Column("created_at", UtcDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_schema_info")),
    )


def downgrade() -> None:
    op.drop_table("schema_info")
