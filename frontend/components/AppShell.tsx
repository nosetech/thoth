"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ShellStatusProvider, useShellStatus } from "@/components/shell/ShellStatus";
import {
  IcApps,
  IcCollapse,
  IcCpu,
  IcExpand,
  IcGrid,
  IcLog,
  IcMenu,
  IcPause,
  IcPlay,
  IcRefresh,
  IcX,
  Spinner,
} from "@/components/apps/icons";
import { fmtTime } from "@/components/apps/ResultSheet";
import { useModal } from "@/components/apps/Modal";
import { NAV_ITEMS, isActive } from "@/lib/nav";

const NAV_ICON = { grid: IcGrid, apps: IcApps, log: IcLog, cpu: IcCpu };

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

/** ブランドロゴ（デザインの「月冠」）。 */
function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M3.5 13 A12.5 12.5 0 0 0 28.5 13 A12.5 9 0 0 1 3.5 13 Z" fill="rgb(20,160,230)" />
      <circle cx="16" cy="11" r="6.6" fill="rgb(202,65,34)" />
      <path
        d="M16 26.5 V30.5 M11 30.5 H21"
        stroke="rgb(20,160,230)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshControl() {
  const { status } = useShellStatus();
  const s = status;
  const enabled = !!s?.active;
  return (
    <div className="refresh">
      <div className="refresh-info" title={`最終更新 ${fmtTime(s?.lastUpdated ?? null)}`}>
        <span
          className={`live ${s?.paused ? "is-paused" : s?.pollErr ? "is-err" : ""}`}
          aria-hidden="true"
        />
        <div>
          <span>
            最終更新 <time className="mono">{fmtTime(s?.lastUpdated ?? null)}</time>
          </span>
          <span className="dim small">
            {s?.paused ? "自動更新は一時停止中" : "5 秒ごとに自動更新"}
          </span>
        </div>
      </div>
      <div className="refresh-btns">
        <button
          type="button"
          className="btn"
          onClick={s?.onRefresh}
          disabled={!enabled || s?.refreshing}
          aria-label="今すぐ更新"
          title="今すぐ更新"
        >
          {s?.refreshing ? <Spinner /> : <IcRefresh size={16} />}
          <span>更新</span>
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={!!s?.paused}
          aria-label={s?.paused ? "自動更新を再開" : "自動更新を一時停止"}
          title={s?.paused ? "自動更新を再開" : "自動更新を一時停止"}
          onClick={s?.onTogglePause}
          disabled={!enabled}
        >
          {s?.paused ? <IcPlay size={14} /> : <IcPause size={16} />}
          <span>{s?.paused ? "再開" : "一時停止"}</span>
        </button>
      </div>
      <div className="pollbar-track" aria-hidden="true">
        {enabled && s && (
          <div
            key={`${s.cycle}-${s.paused}`}
            className={`pollbar ${s.paused ? "is-paused" : ""}`}
          />
        )}
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
  return (
    <>
      <div className="brand">
        <Logo />
        <div>
          <span className="brand-name">THOTH</span>
        </div>
      </div>
      <nav aria-label="メイン">
        <ul className="nav">
          {NAV_ITEMS.map((n) => {
            const Icon = NAV_ICON[n.icon];
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className="nav-item"
                  aria-current={isActive(pathname, n.href) ? "page" : undefined}
                  onClick={onNavigate}
                  title={collapsed ? n.label : undefined}
                >
                  <Icon size={19} />
                  <span className="nav-text">{n.label}</span>
                  {n.href === "/apps" && (status?.errorCount ?? 0) > 0 && (
                    <span className="nav-count" aria-label={`エラー ${status?.errorCount} 件`}>
                      {status?.errorCount}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="side-bottom">
        <RefreshControl />
        <div className={`conn conn-${conn.state}`} title={collapsed ? conn.label : undefined}>
          <span className="conn-dot" aria-hidden="true" />
          <div className="conn-text">
            <strong>{conn.label}</strong>
            <span className="mono">/api</span>
          </div>
        </div>
        {onToggle && (
          <button
            type="button"
            className="btn btn-ghost collapse-btn"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls="sidebar"
            aria-label={collapsed ? "メニューを展開" : "メニューを折りたたむ"}
            title={collapsed ? "メニューを展開" : "メニューを折りたたむ"}
          >
            {collapsed ? <IcExpand size={19} /> : <IcCollapse size={19} />}
            <span className="collapse-text">折りたたむ</span>
          </button>
        )}
      </div>
    </>
  );
}

function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(open, onClose, panel);
  if (!open) return null;
  return (
    <div
      className="overlay drawer-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        id="drawer"
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="ナビゲーション"
      >
        <button
          type="button"
          className="btn btn-ghost icon drawer-close"
          aria-label="メニューを閉じる"
          onClick={onClose}
        >
          <IcX />
        </button>
        {children}
      </div>
    </div>
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
    <div className={`ta shell ${collapsed ? "is-collapsed" : ""}`}>
      <a className="skip" href="#main">
        本文へスキップ
      </a>
      <aside id="sidebar" className="sidebar" aria-label="サイドバー">
        <SideContent pathname={pathname} collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>
      <header className="mheader">
        <button
          type="button"
          className="btn btn-ghost icon"
          aria-label="メニューを開く"
          aria-expanded={drawer}
          aria-controls="drawer"
          onClick={() => setDrawer(true)}
        >
          <IcMenu />
        </button>
        <div className="brand brand-sm">
          <Logo size={28} />
          <span className="brand-name">THOTH</span>
        </div>
        <span className={`conn-dot conn-${conn.state}`} role="img" aria-label={conn.label} />
        {status?.active && (
          <time className="mh-time mono" aria-label={`最終更新 ${fmtTime(status.lastUpdated)}`}>
            {fmtTime(status.lastUpdated)}
          </time>
        )}
        <button
          type="button"
          className="btn btn-ghost icon"
          aria-label="今すぐ更新"
          onClick={status?.onRefresh}
          disabled={!status?.active || status.refreshing}
        >
          {status?.refreshing ? <Spinner /> : <IcRefresh />}
        </button>
      </header>
      <Drawer open={drawer} onClose={() => setDrawer(false)}>
        <SideContent pathname={pathname} onNavigate={() => setDrawer(false)} />
      </Drawer>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

/** 全画面共通のレイアウト（デザイン Artifact 準拠）。md 以上は固定サイドバー、未満はヘッダー + ドロワー。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ShellStatusProvider>
      <Shell>{children}</Shell>
    </ShellStatusProvider>
  );
}
