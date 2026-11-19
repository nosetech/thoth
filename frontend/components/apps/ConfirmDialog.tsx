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

/**
 * 誤操作防止の確認ダイアログ（cosmic-ui の AlertDialog）。キャンセルが先頭で、既定フォーカスになる。
 * Esc・外側クリックでもキャンセル扱いで閉じる。確認ボタンは破壊的な操作（停止など）なら赤、
 * そうでなければ（起動）緑。
 */
export function ConfirmDialog({ cfg, onClose }: { cfg: ConfirmCfg | null; onClose: () => void }) {
  return (
    <AlertDialogRoot
      open={!!cfg}
      onOpenChange={({ open }) => !open && onClose()}
      closeOnEscape
      closeOnInteractOutside
    >
      <AlertDialogContent>
        {cfg && (
          <>
            <AlertDialogTitle>{cfg.title}</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 py-4">{cfg.body}</AlertDialogDescription>
            <div className="flex justify-end gap-3">
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
              <AlertDialogAction
                variant={cfg.destructive ? "destructive" : "success"}
                onClick={cfg.onConfirm}
              >
                {cfg.confirmLabel}
              </AlertDialogAction>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
