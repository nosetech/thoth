import { ApiError } from "./api.ts";

export type Action = "start" | "stop" | "restart";
export type ServiceState = "running" | "stopped" | "unsupported";

export type ServiceDef = { id: string; name: string; kind: string; depends_on: string[] };
export type AppDef = {
  id: string;
  name: string;
  description: string | null;
  modes: string[];
  services: ServiceDef[];
};
export type ServiceStatus = {
  service_id: string;
  kind: string;
  state: ServiceState;
  pid: number | null;
  busy: string | null;
};
export type ModeOption = { name: string; available: boolean; reason: string | null };
export type ModeInfo = { mode: string; modes: ModeOption[] };
export type ServiceResult = {
  service_id: string;
  action: string;
  result: "ok" | "skipped" | "error";
  message: string | null;
};
export type BulkAppResult = {
  app_id: string;
  status: "ok" | "error" | "skipped";
  message: string | null;
  results: ServiceResult[];
};
export type BulkResult = { status: "ok" | "partial" | "failed"; apps: BulkAppResult[] };

export const MODES = ["local", "lan", "vpn"] as const;
export const OP: Record<Action, string> = { start: "起動", stop: "停止", restart: "再起動" };

export type AppStatus = "running" | "stopped" | "partial" | "busy" | "error";

/** サービスの状態からアプリ全体の状態を求める（未対応サービスは除く）。 */
export function appStatus(states: ServiceState[], busy: boolean, error: boolean): AppStatus {
  if (busy) return "busy";
  if (error) return "error";
  const sup = states.filter((s) => s !== "unsupported");
  const r = sup.filter((s) => s === "running").length;
  return r === 0 ? "stopped" : r === sup.length ? "running" : "partial";
}

/** 一括操作の対象アプリか。起動は停止中のサービスを持つもの、停止/再起動は実行中のものが対象。 */
export function isBulkTarget(states: ServiceState[], op: Action): boolean {
  return states.some((s) => (op === "start" ? s === "stopped" : s === "running"));
}

/** 依存順に並べる（依存先が先）。 */
export function topo<T extends { id: string; depends_on: string[] }>(services: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (s: T) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    for (const d of s.depends_on) {
      const t = services.find((x) => x.id === d);
      if (t) visit(t);
    }
    out.push(s);
  };
  services.forEach(visit);
  return out;
}

/** ApiError / 通信エラーからユーザー向けメッセージを作る（内部情報は含めない）。 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: unknown } | string | null;
    const detail = typeof body === "object" && body !== null ? body.detail : body;
    if (typeof detail === "string" && detail) return detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const results = (detail as { results?: ServiceResult[] }).results;
      const msgs = results
        ?.filter((r) => r.result === "error" && r.message)
        .map((r) => `${r.service_id}: ${r.message}`);
      if (msgs?.length) return msgs.join(" / ");
    }
    if (Array.isArray(detail)) return "入力が不正です";
    return `操作に失敗しました (HTTP ${e.status})`;
  }
  return "バックエンドに接続できません";
}

export function countResults(results: { result: "ok" | "skipped" | "error" }[]) {
  const c = { ok: 0, skipped: 0, error: 0 };
  for (const r of results) c[r.result] += 1;
  return c;
}
