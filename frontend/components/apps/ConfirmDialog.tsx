"use client";

import { useRef, type ReactNode } from "react";
import { IcAlert, IcInfo } from "./icons";
import { useModal } from "./Modal";

export type ConfirmCfg = {
  title: string;
  destructive: boolean;
  confirmLabel: string;
  body: ReactNode;
  onConfirm: () => void;
};

/** 誤操作防止の確認ダイアログ。キャンセルが既定フォーカス。 */
export function ConfirmDialog({ cfg, onClose }: { cfg: ConfirmCfg | null; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModal(!!cfg, onClose, panel, cancel);
  if (!cfg) return null;
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`dialog ${cfg.destructive ? "is-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlg-t"
        aria-describedby="dlg-b"
      >
        <div className="dlg-head">
          <span className="dlg-ic">
            {cfg.destructive ? <IcAlert size={20} /> : <IcInfo size={20} />}
          </span>
          <h2 id="dlg-t">{cfg.title}</h2>
        </div>
        <div id="dlg-b" className="dlg-body">
          {cfg.body}
        </div>
        <div className="dlg-actions">
          <button ref={cancel} type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className={`btn ${cfg.destructive ? "btn-danger" : "btn-primary"}`}
            onClick={() => {
              onClose();
              cfg.onConfirm();
            }}
          >
            {cfg.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
