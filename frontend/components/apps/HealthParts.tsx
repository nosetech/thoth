"use client";

import { Activity, CircleHelp, CircleX, History, Hourglass, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ago, type HealthState, type HealthSummary, type ServiceHealth } from "@/lib/health";
import { Badge, type Tone } from "./parts";

export const HEALTH_META: Record<
  HealthState | "error",
  { label: string; tone: Tone; Icon: typeof Activity }
> = {
  healthy: { label: "正常", tone: "ok", Icon: Activity },
  unhealthy: { label: "異常", tone: "danger", Icon: CircleX },
  starting: { label: "起動中", tone: "primary", Icon: Hourglass },
  unknown: { label: "不明", tone: "unsup", Icon: CircleHelp },
  error: { label: "取得できません", tone: "muted", Icon: Unplug },
};

export function HealthBadge({ state, err }: { state: HealthState | undefined; err: boolean }) {
  const m = err ? HEALTH_META.error : HEALTH_META[state ?? "unknown"];
  return (
    <Badge tone={m.tone}>
      <m.Icon size={13} aria-hidden="true" />
      <span className="sr-only">ヘルス:</span>
      <span>{m.label}</span>
    </Badge>
  );
}

/** アプリカード見出しに出す、サービスのヘルス集計バッジ。 */
export function HealthChip({ sum, err }: { sum: HealthSummary; err: boolean }) {
  if (err)
    return (
      <Badge tone="muted">
        <Unplug size={13} aria-hidden="true" />
        <span>ヘルス取得不可</span>
      </Badge>
    );
  if (!sum.running) return null;
  if (sum.unhealthy.length)
    return (
      <Badge tone="danger">
        <CircleX size={13} aria-hidden="true" />
        <span>ヘルス異常 {sum.unhealthy.length}</span>
      </Badge>
    );
  if (sum.starting)
    return (
      <Badge tone="primary">
        <Hourglass size={13} aria-hidden="true" />
        <span>ヘルス確認中</span>
      </Badge>
    );
  if (sum.unknown)
    return (
      <Badge tone="unsup">
        <CircleHelp size={13} aria-hidden="true" />
        <span>ヘルス不明 {sum.unknown}</span>
      </Badge>
    );
  return (
    <Badge tone="ok">
      <Activity size={13} aria-hidden="true" />
      <span>ヘルス正常</span>
    </Badge>
  );
}

/** サービス行のヘルス表示（状態・最新メッセージ・最終チェック・履歴の導線）。 */
export function HealthLine({
  name,
  h,
  err,
  now,
  onHistory,
}: {
  name: string;
  h: ServiceHealth | undefined;
  err: boolean;
  now: number;
  onHistory: () => void;
}) {
  const msg = err
    ? "ヘルス状態を取得できません(サービス操作は利用できます)"
    : (h?.message ?? "チェック結果がありません");
  return (
    <div
      className={`border-primary/20 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border p-2 ${err ? "border-dashed" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-foreground/50 text-[10px] tracking-widest" aria-hidden="true">
          HEALTH
        </span>
        <HealthBadge state={h?.state} err={err} />
      </div>
      <Button
        type="button"
        className="min-h-11 px-3 py-1 text-xs"
        onClick={onHistory}
        aria-label={`${name} のヘルスチェック履歴を開く`}
      >
        <History size={14} aria-hidden="true" />
        <span className="ms-1.5">履歴</span>
      </Button>
      <p className="text-foreground/80 col-span-2 min-w-0 truncate text-xs" title={msg}>
        {msg}
      </p>
      <p className="text-foreground/60 col-span-2 text-xs">
        {h?.checked_at ? (
          <>
            {err ? "最終取得 " : "最終チェック "}
            <time dateTime={h.checked_at} title={new Date(h.checked_at).toLocaleString("ja-JP")}>
              {ago(h.checked_at, now)}
            </time>
          </>
        ) : (
          "未チェック"
        )}
      </p>
    </div>
  );
}
