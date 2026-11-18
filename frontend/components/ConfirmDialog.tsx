"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/** 誤操作防止の確認ダイアログ。Esc / 背景クリックでキャンセルする。 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
        className="bg-background border-primary/60 w-full max-w-md border p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-primary-foreground text-lg font-bold">
          {title}
        </h2>
        <p id="confirm-desc" className="text-foreground/80 mt-2 whitespace-pre-line">
          {description}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="border-primary/40 focus-visible:outline-primary min-h-11 cursor-pointer border px-5 py-2 focus-visible:outline-2"
          >
            キャンセル
          </button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
