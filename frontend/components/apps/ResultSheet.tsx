"use client";

import { Ban, Check, ChevronDown, CircleDashed, SkipForward, TriangleAlert } from "lucide-react";
import {
  SheetCloseTrigger,
  SheetContent,
  SheetDescription,
  SheetRoot,
  SheetTitle,
} from "@/components/ui/sheet";
import { OP, type Action } from "@/lib/apps";
import { Badge, fmtTime, type Tone } from "./parts";

type R = "ok" | "skipped" | "error";
export type BulkView = {
  op: Action;
  onFail: "continue" | "abort";
  overall: "ok" | "partial" | "failed";
  at: Date;
  apps: {
    appId: string;
    name: string;
    result: R;
    summary: string;
    services: { service: string; result: R; message: string }[];
  }[];
};

const RES: Record<R, { tone: Tone; Icon: typeof Check }> = {
  ok: { tone: "ok", Icon: Check },
  skipped: { tone: "muted", Icon: SkipForward },
  error: { tone: "danger", Icon: TriangleAlert },
};

export function ResultBadge({ r }: { r: R }) {
  const m = RES[r];
  return (
    <Badge tone={m.tone}>
      <m.Icon size={12} aria-hidden="true" />
      <span>{r}</span>
    </Badge>
  );
}

const OVERALL = {
  ok: {
    label: "成功",
    tone: "text-teal-300",
    Icon: Check,
    desc: "すべての対象が正常に完了しました",
  },
  partial: {
    label: "一部失敗",
    tone: "text-amber-300",
    Icon: CircleDashed,
    desc: "一部のアプリ・サービスでエラーが発生しました",
  },
  failed: {
    label: "失敗",
    tone: "text-rose-300",
    Icon: TriangleAlert,
    desc: "完了した操作はありません",
  },
};
export const OVERALL_LABEL = { ok: "成功", partial: "一部失敗", failed: "失敗" };

/** 一括操作の結果（cosmic-ui の Sheet。右側に開く）。 */
export function ResultSheet({
  open,
  result,
  onClose,
}: {
  open: boolean;
  result: BulkView | null;
  onClose: () => void;
}) {
  const o = result ? OVERALL[result.overall] : null;
  const cnt = (r: R) => result?.apps.filter((a) => a.result === r).length ?? 0;
  return (
    <SheetRoot open={open && !!result} onOpenChange={({ open: v }) => !v && onClose()}>
      <SheetContent className="max-w-md">
        {result && o && (
          <>
            <SheetCloseTrigger aria-label="結果を閉じる" />
            <p className="text-primary text-xs tracking-widest">BULK RESULT</p>
            <SheetTitle>一括{OP[result.op]}の結果</SheetTitle>
            <SheetDescription>
              {fmtTime(result.at)} 実行 · 失敗時:{" "}
              {result.onFail === "continue" ? "続行 (continue)" : "中断 (abort)"}
            </SheetDescription>
            <div className={`my-4 flex items-center gap-3 border border-primary/30 p-4 ${o.tone}`}>
              <o.Icon size={24} aria-hidden="true" />
              <div className="flex flex-col">
                <strong>
                  {o.label} ({result.overall})
                </strong>
                <span className="text-foreground/70 text-xs">{o.desc}</span>
              </div>
            </div>
            <dl className="mb-4 grid grid-cols-3 gap-2 text-center">
              {(["ok", "skipped", "error"] as const).map((r) => (
                <div key={r} className="border-primary/30 border p-2">
                  <dt className="text-foreground/70 flex items-center justify-center gap-1 text-xs">
                    {r === "ok" ? (
                      <Check size={13} aria-hidden="true" />
                    ) : r === "skipped" ? (
                      <SkipForward size={13} aria-hidden="true" />
                    ) : (
                      <Ban size={13} aria-hidden="true" />
                    )}
                    {r}
                  </dt>
                  <dd className="text-lg font-bold">{cnt(r)}</dd>
                </div>
              ))}
            </dl>
            <ul className="flex flex-col gap-2">
              {result.apps.map((a) => (
                <li key={a.appId} className="border-primary/30 border">
                  <details open={a.result === "error"} className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 p-3">
                      <ResultBadge r={a.result} />
                      <span className="font-bold">{a.name}</span>
                      <span className="text-foreground/70 min-w-0 flex-1 text-xs">{a.summary}</span>
                      <ChevronDown
                        size={16}
                        aria-hidden="true"
                        className="transition-transform group-open:rotate-180"
                      />
                    </summary>
                    <ul className="border-primary/20 flex flex-col gap-2 border-t p-3">
                      {a.services.map((s) => (
                        <li key={s.service} className="flex flex-wrap items-center gap-2 text-xs">
                          <ResultBadge r={s.result} />
                          <span>{s.service}</span>
                          <span className="text-foreground/70 w-full break-words">{s.message}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
      </SheetContent>
    </SheetRoot>
  );
}
