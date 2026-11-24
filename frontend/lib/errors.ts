export type Severity = "error" | "warn";
export const SEVERITIES: readonly Severity[] = ["error", "warn"];

export type ErrorEvent = {
  id: number;
  app_id: string;
  app_name: string;
  service_id: string;
  service_name: string;
  rule_id: string;
  rule_name: string;
  severity: Severity;
  level: string | null;
  source: number;
  file_name: string;
  offset: number;
  line: string;
  detected_at: string;
  acknowledged_at: string | null;
};

export type ServiceErrorSummary = {
  app_id: string;
  app_name: string;
  service_id: string;
  service_name: string;
  unacknowledged: number;
  error: number;
  warn: number;
  latest_at: string;
  latest_line: string;
  latest_severity: Severity;
};

export type ErrorSummary = {
  unacknowledged: number;
  error: number;
  warn: number;
  last_detected_at: string | null;
  services: ServiceErrorSummary[];
};

export type ErrorList = { events: ErrorEvent[]; total: number; summary: ErrorSummary };

export type ErrorRule = {
  id: string;
  name: string;
  severity: Severity;
  levels: string[];
  pattern: string | null;
  exclude: string | null;
  services: string[];
};

export type Parser = {
  kind: "auto" | "regex";
  origin: "service" | "app" | null;
  level_pattern: string | null;
  level_map: Record<string, string>;
};

export type RuleService = {
  service_id: string;
  service_name: string;
  monitored: boolean;
  has_log_paths: boolean;
  parser: Parser;
};

export type AppRules = {
  app_id: string;
  app_name: string;
  mode: "default" | "custom" | "disabled";
  rules: ErrorRule[];
  services: RuleService[];
};

export type Rules = { apps: AppRules[]; monitored_services: number };

/** 一覧の絞り込み。空文字は「すべて」。 */
export type ErrorFilter = {
  app: string;
  service: string;
  rule: string;
  severity: "" | Severity;
  includeAck: boolean;
};

export const EMPTY_FILTER: ErrorFilter = {
  app: "",
  service: "",
  rule: "",
  severity: "",
  includeAck: false,
};

/** 一覧で取得する件数の上限。 */
export const LIST_LIMIT = 200;

export function filterQuery(f: ErrorFilter): Record<string, string | number | boolean | undefined> {
  return {
    app_id: f.app || undefined,
    service_id: f.service || undefined,
    rule_id: f.rule || undefined,
    severity: f.severity || undefined,
    include_acknowledged: f.includeAck || undefined,
    limit: LIST_LIMIT,
  };
}

export function isFiltered(f: ErrorFilter): boolean {
  return !!(f.app || f.service || f.rule || f.severity);
}

/** ERRORS 画面（サービスで絞り込み）への URL。 */
export function errorsHref(appId?: string, serviceId?: string): string {
  const p = new URLSearchParams();
  if (appId) p.set("app", appId);
  if (appId && serviceId) p.set("service", serviceId);
  const qs = p.toString();
  return qs ? `/errors?${qs}` : "/errors";
}

/** URL のクエリから初期の絞り込みを作る（未知のキーは無視）。 */
export function filterFromSearch(search: string): ErrorFilter {
  const p = new URLSearchParams(search);
  const app = p.get("app") ?? "";
  return { ...EMPTY_FILTER, app, service: app ? (p.get("service") ?? "") : "" };
}

/** LOGS 画面（アプリ・サービス・ファイルを選択した状態）への URL。 */
export function logsHref(e: Pick<ErrorEvent, "app_id" | "service_id" | "source" | "file_name">) {
  const p = new URLSearchParams({
    app: e.app_id,
    service: e.service_id,
    source: String(e.source),
    file: e.file_name,
  });
  return `/logs?${p.toString()}`;
}

/** LOGS 画面の URL クエリから選択を読む。揃っていなければ null。 */
export function logTargetFromSearch(
  search: string,
): { app: string; service: string; source: number | null; file: string | null } | null {
  const p = new URLSearchParams(search);
  const app = p.get("app");
  const service = p.get("service");
  if (!app || !service) return null;
  const src = p.get("source");
  const n = src !== null && /^\d+$/.test(src) ? Number(src) : null;
  return { app, service, source: n, file: p.get("file") };
}

/** 「3 分前」などの相対時刻。 */
export function relTime(iso: string, now: number = Date.now()): string {
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
}

export const absTime = (iso: string) => new Date(iso).toLocaleString("ja-JP", { hour12: false });

/** アプリごとの未確認件数（サービス集計から）。件数の多い順。 */
export function unackByApp(
  s: ErrorSummary,
): { app_id: string; app_name: string; error: number; warn: number }[] {
  const m = new Map<string, { app_id: string; app_name: string; error: number; warn: number }>();
  for (const x of s.services) {
    const cur = m.get(x.app_id) ?? { app_id: x.app_id, app_name: x.app_name, error: 0, warn: 0 };
    cur.error += x.error;
    cur.warn += x.warn;
    m.set(x.app_id, cur);
  }
  return [...m.values()].sort((a, b) => b.error + b.warn - (a.error + a.warn));
}
