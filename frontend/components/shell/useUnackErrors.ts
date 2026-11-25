"use client";

import { useCallback, useEffect, useState } from "react";
import { usePolling } from "@/components/shell/usePolling";
import { apiFetch } from "@/lib/api";
import type { ErrorList } from "@/lib/errors";

const CHANGED = "thoth:errors-changed";

/** 確認済みにしたときなど、未確認件数を今すぐ取り直してほしいことを知らせる。 */
export function notifyErrorsChanged() {
  window.dispatchEvent(new Event(CHANGED));
}

/** ナビのバッジ用に、未確認の検知件数を 5 秒ごとに取得する。取得できなければ null。 */
export function useUnackErrors(): number | null {
  const [n, setN] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      const d = await apiFetch<ErrorList>("/api/errors", { query: { limit: 1 } });
      setN(d.summary.unacknowledged);
    } catch {
      setN(null);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const on = () => void load();
    window.addEventListener(CHANGED, on);
    return () => {
      clearTimeout(t);
      window.removeEventListener(CHANGED, on);
    };
  }, [load]);
  usePolling(true, () => void load());
  return n;
}
