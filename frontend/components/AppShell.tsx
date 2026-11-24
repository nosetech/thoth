"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  AppWindow,
  Cpu,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import { Spinner, fmtTime } from "@/components/apps/parts";
import { ShellStatusProvider, useShellStatus } from "@/components/shell/ShellStatus";
import { useUnackErrors } from "@/components/shell/useUnackErrors";
import { Button } from "@/components/ui/button";
import { SheetCloseTrigger, SheetContent, SheetRoot, SheetTitle } from "@/components/ui/sheet";
import { NAV_ITEMS, isActive } from "@/lib/nav";

const NAV_ICON = {
  grid: LayoutDashboard,
  apps: AppWindow,
  log: ScrollText,
  alert: TriangleAlert,
  cpu: Cpu,
};

/** サイドバーの折りたたみ状態（localStorage。SSR・取得不可時は展開）。 */
const COLLAPSE_KEY = "thoth.sidebar";
const listeners = new Set<() => void>();
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "collapsed";
  } catch {
    return false;
  }
}
function toggleCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, readCollapsed() ? "open" : "collapsed");
  } catch {}
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

const CTRL_BTN = "px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40";

/** ブランドロゴ。 */
function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M3.5 13 A12.5 12.5 0 0 0 28.5 13 A12.5 9 0 0 1 3.5 13 Z"
        fill="var(--color-primary)"
      />
      <circle cx="16" cy="11" r="6.6" fill="var(--color-accent)" />
      <path
        d="M16 26.5 V30.5 M11 30.5 H21"
        stroke="var(--color-primary)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshControl({ compact }: { compact?: boolean }) {
  const { status: s } = useShellStatus();
  const enabled = !!s?.active;
  const liveColor = s?.paused ? "bg-foreground/40" : s?.pollErr ? "bg-destructive" : "bg-success";
  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <div
          className="flex items-center gap-2 text-xs"
          title={`最終更新 ${fmtTime(s?.lastUpdated ?? null)}`}
        >
          <span
            className={`size-2 shrink-0 rounded-full ${liveColor} ${s?.paused ? "" : "animate-pulse"}`}
            aria-hidden="true"
          />
          <div className="flex flex-col">
            <span>
              最終更新 <time>{fmtTime(s?.lastUpdated ?? null)}</time>
            </span>
            <span className="text-foreground/60">
              {s?.paused ? "自動更新は一時停止中" : "5 秒ごとに自動更新"}
            </span>
          </div>
        </div>
      )}
      <div className={`flex gap-2 ${compact ? "flex-col" : ""}`}>
        <Button
          type="button"
          className={CTRL_BTN}
          onClick={s?.onRefresh}
          disabled={!enabled || s?.refreshing}
          aria-label="今すぐ更新"
          title="今すぐ更新"
        >
          {s?.refreshing ? <Spinner /> : <RefreshCw size={14} aria-hidden="true" />}
          {!compact && <span className="ms-1.5">更新</span>}
        </Button>
        <Button
          type="button"
          className={CTRL_BTN}
          aria-pressed={!!s?.paused}
          aria-label={s?.paused ? "自動更新を再開" : "自動更新を一時停止"}
          title={s?.paused ? "自動更新を再開" : "自動更新を一時停止"}
          onClick={s?.onTogglePause}
          disabled={!enabled}
        >
          {s?.paused ? (
            <Play size={14} aria-hidden="true" />
          ) : (
            <Pause size={14} aria-hidden="true" />
          )}
          {!compact && <span className="ms-1.5">{s?.paused ? "再開" : "一時停止"}</span>}
        </Button>
      </div>
    </div>
  );
}

function useConn() {
  const { status } = useShellStatus();
  if (status?.connError) return { state: "err", label: "接続できません" } as const;
  if (status?.pollErr) return { state: "warn", label: "更新に失敗中" } as const;
  return { state: "ok", label: "バックエンド接続中" } as const;
}

const CONN_DOT = { ok: "bg-success", warn: "bg-amber-400", err: "bg-destructive" } as const;

function SideContent({
  pathname,
  collapsed,
  onToggle,
  onNavigate,
}: {
  pathname: string;
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const { status } = useShellStatus();
  const conn = useConn();
  const unack = useUnackErrors();
  return (
    <>
      <div className="flex items-center gap-3 px-1">
        <Logo />
        {!collapsed && <span className="text-lg font-bold tracking-widest">THOTH</span>}
      </div>
      <nav aria-label="メイン" className="mt-6 flex-1">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((n) => {
            const Icon = NAV_ICON[n.icon];
            const active = isActive(pathname, n.href);
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  title={collapsed ? n.label : undefined}
                  className={`focus-visible:outline-primary flex items-center gap-3 border-l-2 px-3 py-2 outline-none focus-visible:outline-2 ${
                    active
                      ? "border-l-primary bg-primary/15 text-primary-foreground"
                      : "text-foreground/70 hover:bg-primary/10 border-l-transparent"
                  }`}
                >
                  <Icon size={19} aria-hidden="true" />
                  {!collapsed && <span>{n.label}</span>}
                  {n.href === "/apps" && (status?.errorCount ?? 0) > 0 && (
                    <span
                      className="bg-destructive text-destructive-foreground ms-auto px-1.5 text-xs"
                      aria-label={`エラー ${status?.errorCount} 件`}
                    >
                      {status?.errorCount}
                    </span>
                  )}
                  {n.href === "/errors" && (unack ?? 0) > 0 && (
                    <span
                      className="bg-destructive text-destructive-foreground ms-auto px-1.5 text-xs"
                      aria-label={`未確認の検知 ${unack} 件`}
                    >
                      {(unack ?? 0) > 99 ? "99+" : unack}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-6 flex flex-col gap-4">
        <RefreshControl compact={collapsed} />
        <div className="flex items-center gap-2 text-xs" title={collapsed ? conn.label : undefined}>
          <span
            className={`size-2 shrink-0 rounded-full ${CONN_DOT[conn.state]}`}
            aria-hidden="true"
          />
          {!collapsed && (
            <div className="flex flex-col">
              <strong>{conn.label}</strong>
              <span className="text-foreground/60">/api</span>
            </div>
          )}
        </div>
        {onToggle && (
          <button
            type="button"
            className="text-foreground/70 hover:text-foreground focus-visible:outline-primary flex cursor-pointer items-center gap-3 px-3 py-2 text-xs outline-none focus-visible:outline-2"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls="sidebar"
            aria-label={collapsed ? "メニューを展開" : "メニューを折りたたむ"}
            title={collapsed ? "メニューを展開" : "メニューを折りたたむ"}
          >
            {collapsed ? (
              <PanelLeftOpen size={19} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={19} aria-hidden="true" />
            )}
            {!collapsed && <span>折りたたむ</span>}
          </button>
        )}
      </div>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);
  const { status } = useShellStatus();
  const conn = useConn();

  // md 以上に広がったらドロワーを閉じる
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawer(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div>
      <a
        className="bg-background text-primary focus:border-primary sr-only z-50 p-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:border"
        href="#main"
      >
        本文へスキップ
      </a>
      <aside
        id="sidebar"
        aria-label="サイドバー"
        className={`border-primary/30 bg-background/90 fixed inset-y-0 left-0 z-30 hidden flex-col overflow-y-auto border-r p-4 backdrop-blur md:flex ${
          collapsed ? "w-20" : "w-64"
        }`}
      >
        <SideContent pathname={pathname} collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>
      <header className="border-primary/30 bg-background/90 sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-2 backdrop-blur md:hidden">
        <button
          type="button"
          className="focus-visible:outline-primary cursor-pointer p-1 outline-none focus-visible:outline-2"
          aria-label="メニューを開く"
          aria-expanded={drawer}
          aria-controls="drawer"
          onClick={() => setDrawer(true)}
        >
          <Menu aria-hidden="true" />
        </button>
        <Logo size={28} />
        <span className="font-bold tracking-widest">THOTH</span>
        <span
          className={`ms-auto size-2 rounded-full ${CONN_DOT[conn.state]}`}
          role="img"
          aria-label={conn.label}
        />
        {status?.active && (
          <time className="text-xs" aria-label={`最終更新 ${fmtTime(status.lastUpdated)}`}>
            {fmtTime(status.lastUpdated)}
          </time>
        )}
        <button
          type="button"
          className="focus-visible:outline-primary cursor-pointer p-1 outline-none focus-visible:outline-2 disabled:opacity-40"
          aria-label="今すぐ更新"
          onClick={status?.onRefresh}
          disabled={!status?.active || status.refreshing}
        >
          {status?.refreshing ? <Spinner size={20} /> : <RefreshCw aria-hidden="true" />}
        </button>
      </header>
      <SheetRoot open={drawer} onOpenChange={({ open }) => setDrawer(open)}>
        <SheetContent side="left" className="flex max-w-xs flex-col">
          <SheetTitle className="sr-only">ナビゲーション</SheetTitle>
          <SheetCloseTrigger aria-label="メニューを閉じる" />
          <SideContent pathname={pathname} onNavigate={() => setDrawer(false)} />
        </SheetContent>
      </SheetRoot>
      <main
        id="main"
        tabIndex={-1}
        className={`px-4 py-6 outline-none md:px-8 ${collapsed ? "md:ms-20" : "md:ms-64"}`}
      >
        {children}
      </main>
    </div>
  );
}

/** 全画面共通のレイアウト。md 以上は固定サイドバー、未満はヘッダー + ドロワー（Sheet）。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ShellStatusProvider>
      <Shell>{children}</Shell>
    </ShellStatusProvider>
  );
}
