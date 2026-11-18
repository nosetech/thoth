"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** ページが共通シェル（サイドバー・モバイルヘッダー）へ公開する、更新状態と操作。 */
export type ShellStatus = {
  lastUpdated: Date | null;
  refreshing: boolean;
  paused: boolean;
  pollErr: number;
  cycle: number;
  /** ポーリングが動いている（通常表示中）か */
  active: boolean;
  errorCount: number;
  connError: boolean;
  onRefresh: () => void;
  onTogglePause: () => void;
};

type Ctx = { status: ShellStatus | null; setStatus: (s: ShellStatus | null) => void };
const StatusContext = createContext<Ctx>({ status: null, setStatus: () => {} });

export function ShellStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const value = useMemo(() => ({ status, setStatus }), [status]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export const useShellStatus = () => useContext(StatusContext);
