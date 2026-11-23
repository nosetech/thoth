"use client";

import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleHelp,
  Clock,
  Info,
  Minus,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { ago } from "@/lib/health";
import { isScheduledAbnormal, type ScheduledJob, type ScheduledState } from "@/lib/scheduled";
import { Badge, Spinner, type Tone } from "./parts";

const JOB_META: Record<
  ScheduledState | "error",
  { label: string; tone: Tone; Icon: typeof Ban | null }
> = {
  ok: { label: "正常", tone: "ok", Icon: CircleCheck },
  running: { label: "実行中", tone: "primary", Icon: null },
  failed: { label: "失敗", tone: "danger", Icon: TriangleAlert },
  overdue: { label: "遅延", tone: "danger", Icon: Clock },
  never: { label: "未実行", tone: "muted", Icon: Minus },
  unloaded: { label: "未登録", tone: "unsup", Icon: Ban },
  unknown: { label: "不明", tone: "unsup", Icon: CircleHelp },
  error: { label: "取得できません", tone: "muted", Icon: Unplug },
};

export const JOB_LABEL = (s: ScheduledState): string => JOB_META[s].label;

/** 期待間隔の表示（86400 → 24 時間、172800 → 2 日）。 */
export function fmtInterval(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400} 日`;
  if (sec % 3600 === 0) return `${sec / 3600} 時間`;
  if (sec % 60 === 0) return `${sec / 60} 分`;
  return `${sec} 秒`;
}

export function JobBadge({ state, err }: { state: ScheduledState | undefined; err: boolean }) {
  const m = err ? JOB_META.error : JOB_META[state ?? "unknown"];
  return (
    <Badge tone={m.tone} className={!err && isScheduledAbnormal(state) ? "font-bold" : undefined}>
      {m.Icon ? <m.Icon size={13} aria-hidden="true" /> : <Spinner size={13} />}
      <span className="sr-only">ジョブ状態:</span>
      <span>{m.label}</span>
    </Badge>
  );
}

/** 定期ジョブ行の詳細（スケジュール・最終実行・終了コード・期待間隔・メッセージ）。 */
export function JobLine({
  job,
  err,
  now,
}: {
  job: ScheduledJob | undefined;
  err: boolean;
  now: number;
}) {
  const bad = !err && isScheduledAbnormal(job?.state);
  const msg = err
    ? "定期ジョブの状態を取得できません(サービス操作は利用できます)"
    : (job?.message ?? "状態がありません");
  const last = job?.last_run_at ?? null;
  return (
    <div
      className={`grid w-full gap-2 border p-2 ${err ? "border-foreground/25 border-dashed" : bad ? "border-destructive/60" : "border-primary/20"}`}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-foreground/60">スケジュール</dt>
          <dd>{job?.schedule ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-foreground/60">最終実行</dt>
          <dd>
            {last ? (
              <time
                dateTime={last}
                title={new Date(last).toLocaleString("ja-JP")}
                tabIndex={0}
                className="cursor-help underline decoration-dotted"
              >
                {ago(last, now)}
                <span className="sr-only">({new Date(last).toLocaleString("ja-JP")})</span>
              </time>
            ) : (
              <span className="text-foreground/60">
                {job?.state === "running" ? "実行中" : "実行履歴なし"}
              </span>
            )}
          </dd>
        </div>
        {!err && job?.state === "failed" && job.exit_code != null && (
          <div>
            <dt className="text-foreground/60">終了コード</dt>
            <dd className="font-bold text-rose-300">{job.exit_code}</dd>
          </div>
        )}
        <div>
          <dt className="text-foreground/60">期待間隔</dt>
          <dd>{job?.expected_interval ? fmtInterval(job.expected_interval) : "—"}</dd>
        </div>
      </dl>
      <p className={`min-w-0 truncate text-xs ${bad ? "text-rose-300" : ""}`} title={msg}>
        {msg}
      </p>
    </div>
  );
}

export function JobNote() {
  return (
    <p className="text-foreground/70 flex w-full items-start gap-1.5 text-xs">
      <Info size={14} className="mt-0.5" aria-hidden="true" />
      <span>launchd が定期実行します(起動・停止の操作はありません)</span>
    </p>
  );
}

export const JobKind = () => (
  <Badge tone="primary">
    <CalendarClock size={13} aria-hidden="true" />
    <span>定期ジョブ</span>
  </Badge>
);

/** アプリカードの異常警告（失敗・遅延した定期ジョブ）。 */
export function JobAlert({
  items,
  now,
}: {
  items: { name: string; job: ScheduledJob }[];
  now: number;
}) {
  if (!items.length) return null;
  return (
    <div
      className="border-destructive/60 bg-destructive/10 mb-4 flex items-start gap-3 border p-3"
      role="status"
    >
      <CalendarClock size={18} className="mt-0.5 text-rose-300" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <strong className="text-rose-300">
          定期ジョブ異常 — 直近の実行結果またはスケジュールを確認してください
        </strong>
        <ul className="mt-1 flex flex-col gap-1">
          {items.map(({ name, job }) => (
            <li key={job.service_id} className="text-xs break-words">
              <b>{name}</b> <b className="text-rose-300">[{JOB_LABEL(job.state)}]</b>: {job.message}
              {job.last_run_at && (
                <span className="text-foreground/60">
                  (最終実行{" "}
                  <time title={new Date(job.last_run_at).toLocaleString("ja-JP")}>
                    {ago(job.last_run_at, now)}
                  </time>
                  {job.schedule ? `・${job.schedule}` : ""})
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
