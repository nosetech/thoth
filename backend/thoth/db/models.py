"""SQLAlchemy モデル。

状態・履歴用のテーブルは以降の issue で追加する。
ここでは基盤確認用の最小テーブルのみ定義する。
"""

from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text
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


class HealthResult(Base):
    """ヘルスチェックの 1 回分の結果（保持期間を過ぎたものは定期的に削除する）。

    応答本文・コマンド出力は保存しない（message は probe が作る定型文のみ）。
    """

    __tablename__ = "health_result"
    __table_args__ = (Index("ix_health_result_service", "app_id", "service_id", "checked_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_id: Mapped[str] = mapped_column(String, nullable=False)
    service_id: Mapped[str] = mapped_column(String, nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    checked_at: Mapped[datetime] = mapped_column(UtcDateTime, nullable=False)


class ServiceSupervision(Base):
    """自動再起動のための状態（「稼働させたい」意思・再起動の試行回数・上限到達）。

    稼働させたい（desired）のは、thoth の API で起動に成功してから、停止を要求するまで。
    手動で停止したサービスは desired=False となり、自動再起動の対象にならない。
    """

    __tablename__ = "service_supervision"

    app_id: Mapped[str] = mapped_column(String, primary_key=True)
    service_id: Mapped[str] = mapped_column(String, primary_key=True)
    desired: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    gave_up: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_attempt_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    next_attempt_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    last_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, nullable=False, default=lambda: datetime.now(UTC)
    )


class LogCursor(Base):
    """エラー検知の読み取り位置（log_paths の添字ごと）。thoth 再起動後も続きから読む。

    path は記録時のパス。log_paths が変わって別のファイルを指すようになったら読み直す。
    """

    __tablename__ = "log_cursor"

    app_id: Mapped[str] = mapped_column(String, primary_key=True)
    service_id: Mapped[str] = mapped_column(String, primary_key=True)
    source: Mapped[int] = mapped_column(Integer, primary_key=True)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    inode: Mapped[int] = mapped_column(Integer, nullable=False)
    offset: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, nullable=False, default=lambda: datetime.now(UTC)
    )


class ErrorEvent(Base):
    """エラー検知ルールに一致したログ行（1 行につき最初に一致したルールで 1 件）。

    rule_name・file_name は検知時点の値を残す（ルールやファイルが後で変わっても表示できるように）。
    """

    __tablename__ = "error_event"
    __table_args__ = (
        Index("ix_error_event_detected", "detected_at"),
        Index("ix_error_event_service", "app_id", "service_id", "acknowledged_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    app_id: Mapped[str] = mapped_column(String, nullable=False)
    service_id: Mapped[str] = mapped_column(String, nullable=False)
    rule_id: Mapped[str] = mapped_column(String, nullable=False)
    rule_name: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)  # error / warn
    level: Mapped[str | None] = mapped_column(String, nullable=True)
    source: Mapped[int] = mapped_column(Integer, nullable=False)
    file_name: Mapped[str] = mapped_column(String, nullable=False)
    offset: Mapped[int] = mapped_column(Integer, nullable=False)
    line: Mapped[str] = mapped_column(Text, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(UtcDateTime, nullable=False)
    acknowledged_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
