import { appStatus, type AppDef, type AppStatus, type ServiceStatus } from "./apps.ts";
import { hkey, type HealthSample, type HealthState, type ServiceHealth } from "./health.ts";
import { rkey, type ServiceRestart } from "./restart.ts";
import { isScheduledAbnormal, type ScheduledJob } from "./scheduled.ts";

/** ダッシュボードが扱うアプリ（定義 + サービスの現在状態）。 */
export type DashApp = { def: AppDef; statuses: ServiceStatus[] };

/** 履歴の小さな表示に使う直近件数。 */
export const MINI_STRIP_SIZE = 10;

/** アプリの全体状態。エラー（操作失敗）は /apps の画面内状態なのでここでは扱わない。 */
export function dashAppStatus(a: DashApp): AppStatus {
  return appStatus(
    a.statuses.map((s) => s.state),
    a.statuses.some((s) => !!s.busy),
    false,
  );
}

export type DashCounts = {
  total: number;
  running: number;
  stopped: number;
  partial: number;
  busy: number;
  /** 稼働中のサービス数と対象数（未対応・定期ジョブを除く）。 */
  svcRunning: number;
  svcTotal: number;
  /** 定期ジョブ数（稼働/停止の集計には含めない）。 */
  jobs: number;
};

export function summarize(apps: DashApp[]): DashCounts {
  const c: DashCounts = {
    total: apps.length,
    running: 0,
    stopped: 0,
    partial: 0,
    busy: 0,
    svcRunning: 0,
    svcTotal: 0,
    jobs: 0,
  };
  for (const a of apps) {
    const st = dashAppStatus(a);
    if (st === "running" || st === "stopped" || st === "partial" || st === "busy") c[st] += 1;
    for (const s of a.def.services) {
      if (s.kind === "scheduled") {
        c.jobs += 1;
        continue;
      }
      const state = a.statuses.find((x) => x.service_id === s.id)?.state ?? "unsupported";
      if (state === "unsupported") continue;
      c.svcTotal += 1;
      if (state === "running") c.svcRunning += 1;
    }
  }
  return c;
}

export type AttentionKind =
  "restart-gave-up" | "health" | "job-failed" | "job-overdue" | "retrying";

export type AttentionItem = {
  /** 一意なキー。 */
  id: string;
  kind: AttentionKind;
  /** 小さいほど急ぐ。 */
  sev: number;
  appId: string;
  appName: string;
  serviceId: string;
  serviceName: string;
  message: string;
};

export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  "restart-gave-up": "自動再起動 停止",
  health: "ヘルス異常",
  "job-failed": "定期ジョブ 失敗",
  "job-overdue": "定期ジョブ 遅延",
  retrying: "自動再起動 試行中",
};

export type Sources = {
  health: Record<string, ServiceHealth>;
  healthErr: boolean;
  restart: Record<string, ServiceRestart>;
  restartErr: boolean;
  jobs: Record<string, ScheduledJob>;
  jobsErr: boolean;
};

/** 要対応の一覧（急ぐ順）。取得できない情報源の項目は含めない。 */
export function buildAttention(apps: DashApp[], src: Sources): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of apps) {
    for (const s of a.def.services) {
      const key = hkey(a.def.id, s.id);
      const base = {
        appId: a.def.id,
        appName: a.def.name,
        serviceId: s.id,
        serviceName: s.name || s.id,
      };
      if (s.kind === "scheduled") {
        const j = src.jobs[key];
        if (!src.jobsErr && j && isScheduledAbnormal(j.state)) {
          items.push({
            ...base,
            id: `${key}#job`,
            kind: j.state === "failed" ? "job-failed" : "job-overdue",
            sev: 2,
            message: j.message,
          });
        }
        continue;
      }
      const state = a.statuses.find((x) => x.service_id === s.id)?.state ?? "unsupported";
      if (state === "unsupported") continue;
      const h = src.health[key];
      if (!src.healthErr && state === "running" && h?.state === "unhealthy") {
        items.push({
          ...base,
          id: `${key}#health`,
          kind: "health",
          sev: 2,
          message: h.message ?? "ヘルスチェックに失敗しています",
        });
      }
      const r = src.restart[rkey(a.def.id, s.id)];
      if (!src.restartErr && r?.state === "gave_up") {
        items.push({
          ...base,
          id: `${key}#ar`,
          kind: "restart-gave-up",
          sev: 0,
          message: `上限到達 ${r.attempts}/${r.max_retries} 回。${r.message ?? ""}`.trim(),
        });
      } else if (!src.restartErr && r?.state === "retrying") {
        items.push({
          ...base,
          id: `${key}#ar`,
          kind: "retrying",
          sev: 3,
          message: `試行中 ${r.attempts}/${r.max_retries} 回。${r.message ?? ""}`.trim(),
        });
      }
    }
  }
  return items.sort((x, y) => x.sev - y.sev);
}

export type HealthRow = {
  appId: string;
  appName: string;
  serviceId: string;
  serviceName: string;
  health: ServiceHealth | undefined;
  state: HealthState;
};

/** ヘルスチェック欄の行（定期ジョブ・未対応は除く）と、状態ごとの件数。 */
export function healthRows(
  apps: DashApp[],
  health: Record<string, ServiceHealth>,
): { rows: HealthRow[]; counts: Record<HealthState, number> } {
  const rows: HealthRow[] = [];
  const counts: Record<HealthState, number> = { healthy: 0, unhealthy: 0, starting: 0, unknown: 0 };
  for (const a of apps) {
    for (const s of a.def.services) {
      if (s.kind === "scheduled") continue;
      const state = a.statuses.find((x) => x.service_id === s.id)?.state ?? "unsupported";
      if (state === "unsupported") continue;
      const h = health[hkey(a.def.id, s.id)];
      const hs = h?.state ?? "unknown";
      counts[hs] += 1;
      rows.push({
        appId: a.def.id,
        appName: a.def.name,
        serviceId: s.id,
        serviceName: s.name || s.id,
        health: h,
        state: hs,
      });
    }
  }
  return { rows, counts };
}

/** 直近の推移（左が古く右が新しい）。足りない分は null で左を埋める。 */
export function miniCells(
  history: HealthSample[] | undefined,
  size = MINI_STRIP_SIZE,
): { cells: (HealthSample | null)[]; ok: number; total: number } {
  const recent = (history ?? []).slice(0, size);
  const ok = recent.filter((x) => x.ok).length;
  return {
    cells: [...Array<null>(size - recent.length).fill(null), ...[...recent].reverse()],
    ok,
    total: recent.length,
  };
}

/** /apps の該当箇所へ移動する URL（サービス指定がなければアプリカード）。 */
export function appsHref(appId: string, serviceId?: string): string {
  return serviceId
    ? `/apps#svc-${encodeURIComponent(appId)}--${encodeURIComponent(serviceId)}`
    : `/apps#app-${encodeURIComponent(appId)}`;
}

/** `appsHref` が作る hash から、移動先の DOM id を求める。該当しなければ null。 */
export function hashToElementId(hash: string): string | null {
  const m = /^#(app-|svc-)(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return `${m[1]}${decodeURIComponent(m[2])}`;
  } catch {
    return null;
  }
}

/** DOM id（アプリカード）。 */
export const appElementId = (appId: string) => `app-${appId}`;
/** DOM id（サービス行）。 */
export const serviceElementId = (appId: string, serviceId: string) => `svc-${appId}--${serviceId}`;
