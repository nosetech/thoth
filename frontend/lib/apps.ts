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
export type BulkResult = {
  status: "ok" | "partial" | "failed";
  apps: {
    app_id: string;
    status: "ok" | "error" | "skipped";
    message: string | null;
    results: ServiceResult[];
  }[];
};

export const ACTION_LABEL: Record<Action, string> = {
  start: "起動",
  stop: "停止",
  restart: "再起動",
};

/** 誤操作防止の確認が必要な操作（停止・再起動・一括操作はすべて確認する）。 */
export function needsConfirm(action: Action, scope: "service" | "app" | "bulk"): boolean {
  if (scope === "bulk") return true;
  return action !== "start";
}

export type AppSummary = "running" | "partial" | "stopped" | "unsupported";

/** サービスの状態からアプリ全体の状態を求める。 */
export function summarize(states: ServiceState[]): AppSummary {
  const ops = states.filter((s) => s !== "unsupported");
  if (ops.length === 0) return "unsupported";
  const running = ops.filter((s) => s === "running").length;
  if (running === 0) return "stopped";
  return running === ops.length ? "running" : "partial";
}

export const SUMMARY_LABEL: Record<AppSummary, string> = {
  running: "稼働中",
  partial: "一部稼働",
  stopped: "停止中",
  unsupported: "操作対象外",
};

/** ApiError / 通信エラーからユーザー向けメッセージを作る（詳細な内部情報は含めない）。 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: unknown } | string | null;
    const detail = typeof body === "object" && body !== null ? body.detail : body;
    if (typeof detail === "string" && detail) return detail;
    if (detail && typeof detail === "object") {
      const results = (detail as { results?: ServiceResult[] }).results;
      const msgs = results
        ?.filter((r) => r.result === "error" && r.message)
        .map((r) => `${r.service_id}: ${r.message}`);
      if (msgs?.length) return msgs.join(" / ");
    }
    if (Array.isArray(detail)) return "入力が不正です";
    return `操作に失敗しました (HTTP ${e.status})`;
  }
  return "backend に接続できません";
}

/** アプリ単位・一括操作の結果をユーザー向けの要約にする。 */
export function summarizeResults(results: ServiceResult[]): {
  ok: number;
  skipped: number;
  error: number;
} {
  const c = { ok: 0, skipped: 0, error: 0 };
  for (const r of results) c[r.result] += 1;
  return c;
}
