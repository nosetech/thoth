export type HealthState = "healthy" | "unhealthy" | "starting" | "unknown";

export type ServiceHealth = {
  app_id: string;
  service_id: string;
  state: HealthState;
  message: string | null;
  checked_at: string | null;
};
export type HealthSample = { ok: boolean; message: string | null; checked_at: string };

/** ヘルス状態のキー（app_id/service_id）。 */
export const hkey = (appId: string, serviceId: string) => `${appId}/${serviceId}`;

export const HEALTH_RETENTION_NOTE = "履歴は保持期間（既定 7 日）を過ぎると自動で削除されます";
export const STRIP_SIZE = 30;

/** 経過時間の表示（「12 秒前」など）。未来や不正な値は「たった今」。 */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "たった今";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 時間前`;
  return `${Math.floor(s / 86400)} 日前`;
}

export type HealthSummary = {
  unhealthy: ServiceHealth[];
  starting: number;
  unknown: number;
  healthy: number;
  running: number;
};

/** アプリ全体のヘルス集計（実行中のサービスのみ対象）。 */
export function healthSummary(
  appId: string,
  runningIds: string[],
  health: Record<string, ServiceHealth>,
): HealthSummary {
  const out: HealthSummary = { unhealthy: [], starting: 0, unknown: 0, healthy: 0, running: 0 };
  for (const id of runningIds) {
    out.running += 1;
    const h = health[hkey(appId, id)];
    const st = h?.state ?? "unknown";
    if (st === "unhealthy" && h) out.unhealthy.push(h);
    else if (st === "starting") out.starting += 1;
    else if (st === "healthy") out.healthy += 1;
    else out.unknown += 1;
  }
  return out;
}

/** 直近の推移（左が古く右が新しい）。足りない分は null で左を埋める。 */
export function stripCells(history: HealthSample[], size = STRIP_SIZE): (HealthSample | null)[] {
  const recent = history.slice(0, size);
  return [...Array<null>(size - recent.length).fill(null), ...[...recent].reverse()];
}
