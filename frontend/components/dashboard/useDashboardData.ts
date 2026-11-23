"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "@/components/shell/usePolling";
import { apiFetch } from "@/lib/api";
import type { AppDef, ServiceStatus } from "@/lib/apps";
import { MINI_STRIP_SIZE, type DashApp } from "@/lib/dashboard";
import { hkey, type HealthSample, type ServiceHealth } from "@/lib/health";
import { rkey, type ServiceRestart } from "@/lib/restart";
import type { ScheduledJob } from "@/lib/scheduled";

const byKey = <T>(list: T[], key: (t: T) => string): Record<string, T> =>
  Object.fromEntries(list.map((t) => [key(t), t]));

/**
 * ダッシュボードの表示データを 5 秒ごとに取得する（取得は /api/* のみ）。
 * ヘルス・自動再起動・定期ジョブの取得失敗は、該当ブロックだけのエラーにして前回値を保つ。
 */
export function useDashboardData(paused: boolean) {
  const [apps, setApps] = useState<DashApp[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pollErr, setPollErr] = useState(0);
  const [health, setHealth] = useState<Record<string, ServiceHealth>>({});
  const [healthErr, setHealthErr] = useState(false);
  const [history, setHistory] = useState<Record<string, HealthSample[]>>({});
  const [restart, setRestart] = useState<Record<string, ServiceRestart>>({});
  const [restartErr, setRestartErr] = useState(false);
  const [jobs, setJobs] = useState<Record<string, ScheduledJob>>({});
  const [jobsErr, setJobsErr] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cycle, setCycle] = useState(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const appsRef = useRef<DashApp[] | null>(null);
  useEffect(() => {
    appsRef.current = apps;
  }, [apps]);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const orNull = <T>(p: Promise<T>) =>
        p.then(
          (v) => v,
          () => null,
        );
      const healthP = orNull(apiFetch<ServiceHealth[]>("/api/service-health"));
      const restartP = orNull(apiFetch<ServiceRestart[]>("/api/auto-restart"));
      const jobsP = orNull(apiFetch<ScheduledJob[]>("/api/scheduled"));
      const defs = await apiFetch<AppDef[]>("/api/apps");
      const views = await Promise.all(
        defs.map(async (def): Promise<DashApp> => {
          const statuses = await apiFetch<ServiceStatus[]>(
            `/api/apps/${encodeURIComponent(def.id)}/status`,
          ).catch(() => appsRef.current?.find((v) => v.def.id === def.id)?.statuses ?? []);
          return { def, statuses };
        }),
      );
      const [hl, rl, jl] = await Promise.all([healthP, restartP, jobsP]);
      // 履歴は一覧表示用の小さな推移のみ。取得できないサービスは推移なしにする
      const hist = hl
        ? await Promise.all(
            hl.map(async (h) => {
              const key = hkey(h.app_id, h.service_id);
              const r = await orNull(
                apiFetch<HealthSample[]>(
                  `/api/service-health/${encodeURIComponent(h.app_id)}/${encodeURIComponent(h.service_id)}/history`,
                  { query: { limit: MINI_STRIP_SIZE } },
                ),
              );
              return [key, r] as const;
            }),
          )
        : null;
      if (!mounted.current) return;
      if (hl && hist) {
        setHealth(byKey(hl, (h) => hkey(h.app_id, h.service_id)));
        setHistory((prev) => Object.fromEntries(hist.map(([k, r]) => [k, r ?? prev[k] ?? []])));
      }
      setHealthErr(!hl);
      if (rl) setRestart(byKey(rl, (r) => rkey(r.app_id, r.service_id)));
      setRestartErr(!rl);
      if (jl) setJobs(byKey(jl, (j) => hkey(j.app_id, j.service_id)));
      setJobsErr(!jl);
      setApps(views);
      setLoadError(false);
      setPollErr(0);
      setLastUpdated(new Date());
    } catch {
      if (!mounted.current) return;
      if (appsRef.current === null) setLoadError(true);
      else setPollErr((n) => n + 1);
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRefreshing(false);
        setCycle((c) => c + 1);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = setTimeout(() => void refresh(), 0);
    return () => {
      mounted.current = false;
      clearTimeout(first);
    };
  }, [refresh]);

  const screen = loadError
    ? "error"
    : apps === null
      ? "loading"
      : apps.length === 0
        ? "empty"
        : "normal";
  usePolling(!paused && screen === "normal", () => void refresh());

  const retry = useCallback(() => {
    setLoadError(false);
    void refresh();
  }, [refresh]);

  return {
    apps,
    screen,
    pollErr,
    health,
    healthErr,
    history,
    restart,
    restartErr,
    jobs,
    jobsErr,
    lastUpdated,
    refreshing,
    cycle,
    refresh,
    retry,
  } as const;
}
