"use client";

import { useEffect, useRef } from "react";

/** 状態の定期更新間隔（/apps と共通）。 */
export const POLL_MS = 5000;

/**
 * `enabled` の間、一定間隔で `fn` を呼ぶ。タブが非表示の間は呼ばず、表示に戻ったときに即座に 1 回呼ぶ。
 */
export function usePolling(enabled: boolean, fn: () => void, intervalMs: number = POLL_MS) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => document.visibilityState === "visible" && ref.current();
    const t = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, intervalMs]);
}
