"use client";

import { useEffect, type RefObject } from "react";

function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const f = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),summary,[tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (!root.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** モーダル共通: Esc で閉じる・Tab をパネル内に閉じ込める・開閉時のフォーカス管理・背景スクロール抑止。 */
export function useModal(
  open: boolean,
  onClose: () => void,
  rootRef: RefObject<HTMLElement | null>,
  initialRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = initialRef?.current ?? rootRef.current?.querySelector<HTMLElement>("button");
      el?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab") trapTab(e, rootRef.current);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      if (prev && document.contains(prev)) prev.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
