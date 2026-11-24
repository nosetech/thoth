export type LogLevel = "error" | "warn" | "info" | "debug";
export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

export type LogFile = {
  source: number;
  name: string;
  is_current: boolean;
  size: number | null;
  modified_at: string | null;
  exists: boolean;
};

export type LogService = {
  app_id: string;
  app_name: string;
  service_id: string;
  service_name: string;
  files: LogFile[];
};

export type LogLine = { offset: number; text: string; level: LogLevel | null };

export type LogRead = {
  lines: LogLine[];
  start_offset: number;
  end_offset: number;
  size: number;
  inode: number;
  has_more_before: boolean;
  rotated: boolean;
  scan_limited: boolean;
};

/** 画面に並べる項目。ローテーション検知の区切り行を含む。 */
export type LogEntry =
  | { kind: "line"; key: string; offset: number; text: string; level: LogLevel | null }
  | { kind: "rotated"; key: string; at: string };

/** 画面に保持する行数の上限（追従で増え続けないようにする）。 */
export const MAX_ENTRIES = 2000;
/** 初回・追従の読み込み行数。 */
export const PAGE_LINES = 500;
/** 「さらに前を読み込む」の 1 回の行数。 */
export const OLDER_LINES = 300;

export function toEntries(lines: LogLine[], epoch: number): LogEntry[] {
  return lines.map((l) => ({
    kind: "line",
    key: `${epoch}:${l.offset}`,
    offset: l.offset,
    text: l.text,
    level: l.level,
  }));
}

/** 末尾に追記し、上限を超えた分は先頭から捨てる。 */
export function appendEntries(current: LogEntry[], added: LogEntry[]): LogEntry[] {
  const all = current.concat(added);
  return all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all;
}

/** 検索語の一致箇所で分割する（大文字小文字は区別しない）。 */
export function splitByQuery(text: string, query: string): { text: string; match: boolean }[] {
  if (!query) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    if (j > i) out.push({ text: text.slice(i, j), match: false });
    out.push({ text: text.slice(j, j + needle.length), match: true });
    i = j + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), match: false });
  return out.length ? out : [{ text, match: false }];
}

export function countMatches(entries: LogEntry[], query: string): number {
  if (!query) return 0;
  const needle = query.toLowerCase();
  let n = 0;
  for (const e of entries) {
    if (e.kind !== "line") continue;
    const hay = e.text.toLowerCase();
    let i = 0;
    while ((i = hay.indexOf(needle, i)) >= 0) {
      n++;
      i += needle.length;
    }
  }
  return n;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${units[u]}`;
}

/** レベル絞り込みを API の `levels` に変換する。全選択・未選択は絞り込みなし。 */
export function levelsParam(selected: ReadonlySet<LogLevel>): string | undefined {
  if (selected.size === 0 || selected.size === LOG_LEVELS.length) return undefined;
  return LOG_LEVELS.filter((l) => selected.has(l)).join(",");
}

/** 読み込みエラーの種類。 */
export type LogErrorKind = "missing" | "denied" | "other";

export function classifyLogError(status: number | undefined): LogErrorKind {
  if (status === 404) return "missing";
  if (status === 403) return "denied";
  return "other";
}

/** 「さらに前を読み込む」で読む行数（表示上限を超えない範囲）。0 なら読み込めない。 */
export function olderCount(current: number): number {
  return Math.max(0, Math.min(OLDER_LINES, MAX_ENTRIES - current));
}

/** 先頭に追加し、上限を超えた分は末尾から捨てない（上限内の件数だけ呼び出し側で渡す）。 */
export function prependEntries(current: LogEntry[], older: LogEntry[]): LogEntry[] {
  return older.concat(current);
}
