"use client";

import type { ReactNode } from "react";
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmCfg = {
  title: string;
  destructive: boolean;
  confirmLabel: string;
  body: ReactNode;
  onConfirm: () => void;
};

/** 誤操作防止の確認ダイアログ（cosmic-ui の AlertDialog）。キャンセルが先頭で、既定フォーカスになる。 */
export function ConfirmDialog({ cfg, onClose }: { cfg: ConfirmCfg | null; onClose: () => void }) {
  return (
    <AlertDialogRoot open={!!cfg} onOpenChange={({ open }) => !open && onClose()}>
      <AlertDialogContent>
        {cfg && (
          <>
            <AlertDialogTitle>{cfg.title}</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 py-4">{cfg.body}</AlertDialogDescription>
            <div className="flex justify-end gap-3">
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
              <AlertDialogAction onClick={cfg.onConfirm}>{cfg.confirmLabel}</AlertDialogAction>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
