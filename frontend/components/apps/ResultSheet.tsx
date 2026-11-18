"use client";

import { useRef } from "react";
import { OP, type Action } from "@/lib/apps";
import { IcAlert, IcCheck, IcChevron, IcHalf, IcSkip, IcX } from "./icons";
import { useModal } from "./Modal";

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

export const fmtTime = (d: Date | null) =>
  d ? d.toLocaleTimeString("ja-JP", { hour12: false }) : "—";

const RES = {
  ok: { cls: "ok", Icon: IcCheck },
  skipped: { cls: "muted", Icon: IcSkip },
  error: { cls: "danger", Icon: IcAlert },
};

export function ResultBadge({ r }: { r: R }) {
  const m = RES[r];
  return (
    <span className={`badge b-${m.cls} res-badge`}>
      <m.Icon size={12} />
      <span className="mono">{r}</span>
    </span>
  );
}

const OVERALL = {
  ok: { label: "成功", cls: "ok", Icon: IcCheck, desc: "すべての対象が正常に完了しました" },
  partial: {
    label: "一部失敗",
    cls: "warn",
    Icon: IcHalf,
    desc: "一部のアプリ・サービスでエラーが発生しました",
  },
  failed: { label: "失敗", cls: "danger", Icon: IcAlert, desc: "完了した操作はありません" },
};
export const OVERALL_LABEL = { ok: "成功", partial: "一部失敗", failed: "失敗" };

/** 一括操作の結果。モバイルはボトムシート、md 以上は右サイドシート。 */
export function ResultSheet({
  open,
  result,
  onClose,
}: {
  open: boolean;
  result: BulkView | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModal(open, onClose, panel, closeRef);
  if (!open || !result) return null;
  const o = OVERALL[result.overall];
  const cnt = (r: R) => result.apps.filter((a) => a.result === r).length;
  return (
    <div
      className="overlay sheet-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        ref={panel}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-t"
      >
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <div>
            <p className="eyebrow">BULK RESULT</p>
            <h2 id="sheet-t">一括{OP[result.op]}の結果</h2>
            <p className="dim small">
              {fmtTime(result.at)} 実行 · 失敗時:{" "}
              {result.onFail === "continue" ? "続行 (continue)" : "中断 (abort)"}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost icon"
            aria-label="結果を閉じる"
            onClick={onClose}
          >
            <IcX />
          </button>
        </header>
        <div className="sheet-body">
          <div className={`overall o-${o.cls}`}>
            <o.Icon size={24} />
            <div>
              <strong>
                {o.label} <span className="mono">({result.overall})</span>
              </strong>
              <span>{o.desc}</span>
            </div>
          </div>
          <dl className="counts">
            <div>
              <dt>
                <IcCheck size={13} />
                ok
              </dt>
              <dd>{cnt("ok")}</dd>
            </div>
            <div>
              <dt>
                <IcSkip size={13} />
                skipped
              </dt>
              <dd>{cnt("skipped")}</dd>
            </div>
            <div>
              <dt>
                <IcAlert size={13} />
                error
              </dt>
              <dd>{cnt("error")}</dd>
            </div>
          </dl>
          <ul className="res-apps">
            {result.apps.map((a) => (
              <li key={a.appId}>
                <details open={a.result === "error"}>
                  <summary>
                    <ResultBadge r={a.result} />
                    <span className="mono strong">{a.name}</span>
                    <span className="dim res-sum">{a.summary}</span>
                    <IcChevron size={16} className="chev" />
                  </summary>
                  <ul className="res-svcs">
                    {a.services.map((s) => (
                      <li key={s.service}>
                        <ResultBadge r={s.result} />
                        <span className="mono">{s.service}</span>
                        <span className="res-msg">{s.message}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </div>
        <footer className="sheet-foot">
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
        </footer>
      </aside>
    </div>
  );
}
