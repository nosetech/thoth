"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import {
  OLDER_LINES,
  PAGE_LINES,
  appendEntries,
  classifyLogError,
  levelsParam,
  olderCount,
  toEntries,
  type LogEntry,
  type LogErrorKind,
  type LogLevel,
  type LogRead,
} from "@/lib/logs";

export type LogTarget = { appId: string; serviceId: string; source: number; name: string };

export type LogView =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok" }
  | { status: "error"; kind: LogErrorKind };

export type LogFilter = { q: string; levels: ReadonlySet<LogLevel> };

const hms = () => new Date().toLocaleTimeString("ja-JP", { hour12: false });

/**
 * 選択中ログの読み込み・追従・遡り。応答の取り違えを避けるため、世代（epoch）が変わった応答は捨てる。
 * `follow` が true の間、`pollTick` が変わるたびに追記分を取得する。
 */
export function useLogViewer(
  target: LogTarget | null,
  filter: LogFilter,
  follow: boolean,
  pollTick: number,
  onRotated: () => void,
  announce: (message: string) => void,
) {
  const [view, setView] = useState<LogView>({ status: "idle" });
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [meta, setMeta] = useState({
    startOffset: 0,
    endOffset: 0,
    size: 0,
    hasMore: false,
    scanLimited: false,
  });
  const [followErr, setFollowErr] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const inode = useRef<number | null>(null);
  const busy = useRef(false);
  const prepended = useRef(0); // 直近の遡り読み込みで先頭に足した件数（スクロール位置の補正用）
  const [prependedTick, setPrependedTick] = useState(0);

  const q = filter.q;
  const levelsKey = levelsParam(filter.levels) ?? "";
  const tkey = target ? `${target.appId}/${target.serviceId}/${target.source}/${target.name}` : "";

  const params = useCallback(
    () => ({
      app_id: target?.appId,
      service_id: target?.serviceId,
      source: target?.source,
      name: target?.name,
      q: q || undefined,
      levels: levelsKey || undefined,
    }),
    [target, q, levelsKey],
  );

  // 初回・選択/絞り込み変更・再試行
  useEffect(() => {
    if (!target) return;
    const my = ++epoch.current;
    inode.current = null;
    const t0 = setTimeout(() => {
      setView({ status: "loading" });
      setFollowErr(false);
    }, 0);
    // 検索語の入力中に連続して取得しない
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch<LogRead>("/api/logs/read", {
          query: { ...params(), lines: PAGE_LINES },
        });
        if (my !== epoch.current) return;
        inode.current = r.inode;
        setEntries(toEntries(r.lines, my));
        setMeta({
          startOffset: r.start_offset,
          endOffset: r.end_offset,
          size: r.size,
          hasMore: r.has_more_before,
          scanLimited: r.scan_limited,
        });
        setView({ status: "ok" });
      } catch (e) {
        if (my !== epoch.current) return;
        setEntries([]);
        setView({
          status: "error",
          kind: classifyLogError(e instanceof ApiError ? e.status : undefined),
        });
        announce("ログを取得できませんでした");
      }
    }, 250);
    return () => {
      clearTimeout(t0);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey, q, levelsKey, reload]);

  // 追従
  const lastTick = useRef(pollTick);
  useEffect(() => {
    if (pollTick === lastTick.current) return;
    lastTick.current = pollTick;
    if (!follow || view.status !== "ok" || !target || busy.current) return;
    const my = epoch.current;
    busy.current = true;
    (async () => {
      try {
        const r = await apiFetch<LogRead>("/api/logs/read", {
          query: { ...params(), after: meta.endOffset, inode: inode.current, lines: PAGE_LINES },
        });
        if (my !== epoch.current) return;
        setFollowErr(false);
        inode.current = r.inode;
        if (r.rotated) {
          const at = hms();
          const sep: LogEntry = { kind: "rotated", key: `${my}:rot:${Date.now()}`, at };
          setEntries((cur) => appendEntries(cur, [sep, ...toEntries(r.lines, Date.now())]));
          setMeta({
            startOffset: r.start_offset,
            endOffset: r.end_offset,
            size: r.size,
            hasMore: false, // 旧ファイルの内容は世代ファイルで見る
            scanLimited: false,
          });
          announce(`ログがローテーションされました(${at})。新しいファイルから追従を続けます`);
          onRotated();
        } else if (r.lines.length > 0 || r.end_offset !== meta.endOffset) {
          setEntries((cur) => appendEntries(cur, toEntries(r.lines, my)));
          setMeta((m) => ({ ...m, endOffset: r.end_offset, size: r.size }));
        }
      } catch {
        if (my === epoch.current) setFollowErr(true);
      } finally {
        busy.current = false;
      }
    })();
  }, [pollTick, follow, view.status, target, params, meta.endOffset, onRotated, announce]);

  const loadOlder = useCallback(async () => {
    if (!target || loadingOlder || view.status !== "ok") return;
    const n = olderCount(entries.filter((e) => e.kind === "line").length);
    if (n === 0 || !meta.hasMore) return;
    const my = epoch.current;
    setLoadingOlder(true);
    try {
      const r = await apiFetch<LogRead>("/api/logs/read", {
        query: { ...params(), before: meta.startOffset, lines: Math.min(n, OLDER_LINES) },
      });
      if (my !== epoch.current) return;
      const older = toEntries(r.lines, my);
      prepended.current = older.length;
      setEntries((cur) => older.concat(cur));
      setMeta((m) => ({
        ...m,
        startOffset: r.start_offset,
        hasMore: r.has_more_before,
        scanLimited: r.scan_limited,
      }));
      setPrependedTick((t) => t + 1);
      announce(`${older.length} 行を前に読み込みました`);
    } catch {
      if (my === epoch.current) announce("前の行を取得できませんでした");
    } finally {
      setLoadingOlder(false);
    }
  }, [target, loadingOlder, view.status, entries, meta, params, announce]);

  return {
    view: target ? view : ({ status: "idle" } as LogView),
    entries: target ? entries : [],
    size: meta.size,
    hasMore: meta.hasMore,
    scanLimited: meta.scanLimited,
    followErr,
    loadingOlder,
    prependedTick,
    prepended,
    loadOlder,
    retry: () => setReload((r) => r + 1),
  };
}
