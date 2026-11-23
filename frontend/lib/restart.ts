import { hkey } from "./health.ts";

export type RestartState = "watching" | "retrying" | "gave_up" | "idle";

/** GET /api/auto-restart の 1 件（auto_restart を指定したサービスのみ返る）。 */
export type ServiceRestart = {
  app_id: string;
  service_id: string;
  state: RestartState;
  attempts: number;
  max_retries: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  message: string | null;
};

export const rkey = hkey;

export type RestartSummary = { gaveUp: ServiceRestart[]; retrying: ServiceRestart[] };

/** アプリ内の上限到達・試行中のサービス。 */
export function restartSummary(
  appId: string,
  serviceIds: string[],
  restart: Record<string, ServiceRestart>,
): RestartSummary {
  const out: RestartSummary = { gaveUp: [], retrying: [] };
  for (const id of serviceIds) {
    const r = restart[rkey(appId, id)];
    if (!r) continue;
    if (r.state === "gave_up") out.gaveUp.push(r);
    else if (r.state === "retrying") out.retrying.push(r);
  }
  return out;
}

/** 次の試行までの残り秒数。予定が無い・不正なら null。 */
export function secondsUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.ceil((t - now) / 1000);
}
