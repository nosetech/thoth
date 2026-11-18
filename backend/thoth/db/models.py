"""SQLAlchemy モデル。

状態・履歴用のテーブルは以降の issue で追加する。
ここでは基盤確認用の最小テーブルのみ定義する。
"""

from datetime import UTC, datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from thoth.db.base import Base


class UtcDateTime(TypeDecorator):
    """UTC で保存する日時型。naive な値の書き込みはエラー。"""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive な datetime は書き込めません（tz 付きで指定してください）")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        return None if value is None else value.replace(tzinfo=UTC)


class SchemaInfo(Base):
    """基盤確認用テーブル（マイグレーション動作の確認に使う）。"""

    __tablename__ = "schema_info"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    note: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime, nullable=False, default=lambda: datetime.now(UTC)
    )


class AppState(Base):
    """アプリごとの状態（現在の起動モード）。登録定義は YAML が正なので複製しない。

    app_id は YAML 側の id を文字列で参照する（外部キーなし。YAML から削除されても残す）。
    """

    __tablename__ = "app_state"

    app_id: Mapped[str] = mapped_column(String, primary_key=True)
    mode: Mapped[str] = mapped_column(String, nullable=False, default="local")
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, nullable=False, default=lambda: datetime.now(UTC)
    )


class ServiceProcess(Base):
    """thoth が把握しているプロセス（thoth 再起動後も PID を引き継ぐための状態）。

    PID の再利用による誤 kill を防ぐため、起動時刻（ps の lstart）を照合に使う。
    app_id / service_id は YAML 側の id を文字列で参照する（外部キーなし）。
    """

    __tablename__ = "service_process"

    app_id: Mapped[str] = mapped_column(String, primary_key=True)
    service_id: Mapped[str] = mapped_column(String, primary_key=True)
    pid: Mapped[int] = mapped_column(Integer, nullable=False)
    proc_started: Mapped[str] = mapped_column(String, nullable=False)
    command: Mapped[str] = mapped_column(Text, nullable=False, default="")
    recorded_at: Mapped[datetime] = mapped_column(
        UtcDateTime, nullable=False, default=lambda: datetime.now(UTC)
    )


class ServiceOperation(Base):
    """起動・停止・再起動の実行結果の履歴（環境変数の値は記録しない）。"""

    __tablename__ = "service_operation"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_id: Mapped[str] = mapped_column(String, nullable=False)
    service_id: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)  # succeeded / failed / rejected
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime, nullable=False)
    finished_at: Mapped[datetime] = mapped_column(UtcDateTime, nullable=False)
