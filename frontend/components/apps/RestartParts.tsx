"use client";

import { CirclePause, Play, RotateCw, TriangleAlert, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { secondsUntil, type ServiceRestart } from "@/lib/restart";
import { Badge, Spinner, fmtTime } from "./parts";

/** サービスの「起動」ボタンの DOM id（自動再起動の警告から移動・フォーカスするため）。 */
export const startButtonId = (appId: string, serviceId: string) => `start-${appId}-${serviceId}`;

export function focusStartButton(appId: string, serviceId: string) {
  const el = document.getElementById(startButtonId(appId, serviceId));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => el.focus({ preventScroll: true }), 250);
}

/** サービス名の横の控えめなチップ（監視中・手動停止中・取得不可）。試行中・上限到達は RestartLine で出す。 */
export function RestartChip({ r, err }: { r: ServiceRestart | undefined; err: boolean }) {
  if (!r) return null;
  if (!err && (r.state === "retrying" || r.state === "gave_up")) return null;
  const meta = err
    ? { label: "自動再起動: 取得できません", Icon: Unplug, idle: true }
    : r.state === "idle"
      ? { label: "自動再起動: 待機(手動停止中)", Icon: CirclePause, idle: true }
      : { label: "自動再起動: 有効", Icon: RotateCw, idle: false };
  const tip = err ? "自動再起動の状態を取得できません" : (r.message ?? "");
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] ${
        meta.idle
          ? "border-foreground/30 text-foreground/60 border-dashed"
          : "border-primary/40 text-sky-300"
      }`}
      title={tip || undefined}
    >
      <meta.Icon size={12} aria-hidden="true" />
      <span>{meta.label}</span>
      {tip && <span className="sr-only">。{tip}</span>}
    </span>
  );
}

/** サービス行の下に出す、試行中・上限到達の表示。 */
export function RestartLine({
  r,
  err,
  now,
  onStartFocus,
}: {
  r: ServiceRestart | undefined;
  err: boolean;
  now: number;
  onStartFocus: () => void;
}) {
  if (!r || err || (r.state !== "retrying" && r.state !== "gave_up")) return null;
  if (r.state === "retrying") {
    const left = secondsUntil(r.next_attempt_at, now);
    return (
      <div className="w-full border border-amber-400/40 bg-amber-400/5 p-2 text-xs" role="status">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-foreground/50 text-[10px] tracking-widest" aria-hidden="true">
            AUTO-RESTART
          </span>
          <Badge tone="warn">
            <Spinner size={12} />
            <span>
              再起動を試行中{" "}
              <b>
                {r.attempts}/{r.max_retries}
              </b>{" "}
              回
            </span>
          </Badge>
          <span className="flex gap-0.5" aria-hidden="true">
            {Array.from({ length: r.max_retries }, (_, i) => (
              <i
                key={i}
                className={`inline-block size-2 border border-amber-400/60 ${i < r.attempts ? "bg-amber-400" : ""}`}
              />
            ))}
          </span>
          {r.next_attempt_at && (
            <span>
              次の試行{" "}
              <time dateTime={r.next_attempt_at}>{fmtTime(new Date(r.next_attempt_at))}</time>
              <span className="text-foreground/60">
                ({left == null ? "—" : left > 0 ? `あと ${left} 秒` : "まもなく"})
              </span>
            </span>
          )}
        </div>
        {r.message && (
          <p className="text-foreground/80 mt-1.5 truncate" title={r.message}>
            {r.message}
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      className="border-destructive/60 bg-destructive/10 w-full border p-2 text-xs"
      role="status"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-foreground/50 text-[10px] tracking-widest" aria-hidden="true">
          AUTO-RESTART
        </span>
        <Badge tone="danger">
          <TriangleAlert size={12} aria-hidden="true" />
          <span>自動再起動を停止(上限 {r.max_retries} 回)</span>
        </Badge>
      </div>
      <p className="mt-1.5 break-words">
        {r.message}
        {r.last_attempt_at && (
          <span className="text-foreground/60">
            {" "}
            最終試行{" "}
            <time dateTime={r.last_attempt_at}>
              {new Date(r.last_attempt_at).toLocaleString("ja-JP")}
            </time>
          </span>
        )}
      </p>
      <Button type="button" className="mt-2 min-h-11 px-3 py-1 text-xs" onClick={onStartFocus}>
        <Play size={13} aria-hidden="true" />
        <span className="ms-1.5">起動ボタンへ</span>
      </Button>
    </div>
  );
}

/** アプリカード見出しのバッジ（上限到達 > 試行中）。 */
export function RestartBadge({
  gaveUp,
  retrying,
  err,
}: {
  gaveUp: number;
  retrying: number;
  err: boolean;
}) {
  if (err) return null;
  if (gaveUp > 0)
    return (
      <Badge tone="danger">
        <TriangleAlert size={13} aria-hidden="true" />
        <span>自動再起動停止 {gaveUp}</span>
      </Badge>
    );
  if (retrying > 0)
    return (
      <Badge tone="warn">
        <RotateCw size={13} aria-hidden="true" />
        <span>自動再起動 試行中</span>
      </Badge>
    );
  return null;
}
