"use client";

import { useState } from "react";
import { Info, History } from "lucide-react";
import {
  SheetCloseTrigger,
  SheetContent,
  SheetDescription,
  SheetRoot,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  ago,
  HEALTH_RETENTION_NOTE,
  stripCells,
  type HealthSample,
  type ServiceHealth,
} from "@/lib/health";
import { HEALTH_META } from "./HealthParts";
import { Badge } from "./parts";

const fmtFull = (iso: string) => new Date(iso).toLocaleString("ja-JP", { hour12: false });
const PAGE = 30;

export type HealthTarget = { appId: string; serviceId: string; label: string };

/** ヘルスチェック履歴（cosmic-ui の Sheet。右側に開く）。 */
export function HealthSheet({
  target,
  health,
  history,
  historyErr,
  err,
  now,
  onClose,
}: {
  target: HealthTarget | null;
  health: ServiceHealth | undefined;
  history: HealthSample[] | null;
  historyErr: boolean;
  err: boolean;
  now: number;
  onClose: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const m = err ? HEALTH_META.error : HEALTH_META[health?.state ?? "unknown"];
  const hist = history ?? [];
  const recent = hist.slice(0, 30);
  const okN = recent.filter((x) => x.ok).length;
  const ngN = recent.length - okN;
  return (
    <SheetRoot
      open={!!target}
      onOpenChange={({ open }) => {
        if (!open) {
          setLimit(PAGE);
          onClose();
        }
      }}
    >
      <SheetContent className="max-w-md">
        {target && (
          <>
            <SheetCloseTrigger aria-label="履歴を閉じる" />
            <p className="text-primary text-xs tracking-widest">HEALTH HISTORY</p>
            <SheetTitle>{target.label}</SheetTitle>
            <SheetDescription>ヘルスチェックの結果（新しい順）</SheetDescription>
            <div className="border-primary/30 my-4 flex items-center gap-3 border p-4">
              <Badge tone={m.tone}>
                <m.Icon size={13} aria-hidden="true" />
                <span>{m.label}</span>
              </Badge>
              <div className="flex min-w-0 flex-col text-xs">
                <span className="break-words">{health?.message ?? "チェック結果がありません"}</span>
                <span className="text-foreground/60">
                  最終チェック{" "}
                  {health?.checked_at
                    ? `${fmtFull(health.checked_at)}(${ago(health.checked_at, now)})`
                    : "なし"}
                </span>
              </div>
            </div>
            {(err || historyErr) && (
              <p role="status" className="border-primary/30 mb-4 border border-dashed p-3 text-xs">
                {historyErr
                  ? "履歴を取得できません。表示は取得済みの内容です。"
                  : "最新のヘルス状態を取得できません。"}
              </p>
            )}
            {history === null && !historyErr ? (
              <p className="text-foreground/60 text-xs">読み込み中…</p>
            ) : hist.length === 0 ? (
              <div className="border-primary/20 flex flex-col items-center gap-2 border p-6 text-center">
                <History size={28} aria-hidden="true" />
                <strong>まだチェック結果がありません</strong>
                <p className="text-foreground/70 text-xs">
                  停止中のサービスはチェックされません。起動すると定期チェックが始まります。
                </p>
              </div>
            ) : (
              <>
                <section aria-labelledby="hs-strip" className="mb-4">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 id="hs-strip" className="text-sm font-bold">
                      直近 {recent.length} 件の推移
                    </h3>
                    <span className="text-xs">
                      <span className="text-teal-300">成功 {okN}</span> /{" "}
                      <span className={ngN ? "text-rose-300" : ""}>失敗 {ngN}</span>(成功率{" "}
                      {Math.round((okN / recent.length) * 100)}%)
                    </span>
                  </div>
                  <div
                    role="img"
                    aria-label={`直近 ${recent.length} 件: 成功 ${okN} 件、失敗 ${ngN} 件。左が古く右が新しい`}
                    className="flex gap-0.5"
                  >
                    {stripCells(hist).map((c, i) => (
                      <span
                        key={i}
                        title={
                          c
                            ? `${fmtFull(c.checked_at)} ${c.ok ? "成功" : "失敗"}: ${c.message ?? ""}`
                            : "データなし"
                        }
                        className={`h-6 min-w-0 flex-1 ${
                          c ? (c.ok ? "bg-success/70" : "bg-destructive/80") : "bg-foreground/10"
                        }`}
                      />
                    ))}
                  </div>
                  <div className="text-foreground/50 mt-1 flex justify-between text-xs" aria-hidden>
                    <span>← 古い</span>
                    <span>新しい →</span>
                  </div>
                </section>
                <section aria-labelledby="hs-list">
                  <h3 id="hs-list" className="mb-2 text-sm font-bold">
                    明細(新しい順・全 {hist.length} 件)
                  </h3>
                  <ol className="flex flex-col gap-1.5">
                    {hist.slice(0, limit).map((x, i) => (
                      <li
                        key={`${x.checked_at}-${i}`}
                        className="border-primary/20 flex flex-wrap items-center gap-2 border p-2 text-xs"
                      >
                        <Badge tone={x.ok ? "ok" : "danger"}>{x.ok ? "成功" : "失敗"}</Badge>
                        <span className="min-w-0 flex-1 break-words">{x.message}</span>
                        <time className="text-foreground/60" dateTime={x.checked_at}>
                          {fmtFull(x.checked_at)}
                        </time>
                      </li>
                    ))}
                  </ol>
                  {hist.length > limit && (
                    <Button
                      type="button"
                      className="mt-2 w-full text-xs"
                      onClick={() => setLimit((l) => l + PAGE)}
                    >
                      さらに表示(残り {hist.length - limit} 件)
                    </Button>
                  )}
                </section>
              </>
            )}
            <p className="text-foreground/60 mt-4 flex items-center gap-1.5 text-xs">
              <Info size={13} aria-hidden="true" />
              {HEALTH_RETENTION_NOTE}
            </p>
          </>
        )}
      </SheetContent>
    </SheetRoot>
  );
}
