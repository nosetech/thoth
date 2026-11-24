import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_ENTRIES,
  OLDER_LINES,
  olderCount,
  appendEntries,
  classifyLogError,
  countMatches,
  formatBytes,
  levelsParam,
  splitByQuery,
  toEntries,
  type LogEntry,
} from "./logs.ts";

const line = (offset: number, text: string): LogEntry => ({
  kind: "line",
  key: `0:${offset}`,
  offset,
  text,
  level: null,
});

test("splitByQuery: 大文字小文字を区別せず一致箇所を分割", () => {
  assert.deepEqual(splitByQuery("Error: db ERROR", "error"), [
    { text: "Error", match: true },
    { text: ": db ", match: false },
    { text: "ERROR", match: true },
  ]);
  assert.deepEqual(splitByQuery("abc", ""), [{ text: "abc", match: false }]);
  assert.deepEqual(splitByQuery("abc", "x"), [{ text: "abc", match: false }]);
});

test("countMatches: 行内の複数一致も数え、区切り行は無視", () => {
  const entries: LogEntry[] = [
    line(0, "ab ab"),
    { kind: "rotated", key: "r", at: "x" },
    line(6, "AB"),
  ];
  assert.equal(countMatches(entries, "ab"), 3);
  assert.equal(countMatches(entries, ""), 0);
});

test("appendEntries: 上限を超えたら先頭から捨てる", () => {
  const base = toEntries(
    Array.from({ length: MAX_ENTRIES }, (_, i) => ({ offset: i, text: "x", level: null })),
    0,
  );
  const next = appendEntries(base, toEntries([{ offset: 99999, text: "new", level: null }], 1));
  assert.equal(next.length, MAX_ENTRIES);
  assert.equal(next.at(-1)?.kind === "line" && next.at(-1)?.key, "1:99999");
  assert.equal(next[0].kind === "line" && next[0].offset, 1);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(1536), "1.5KB");
  assert.equal(formatBytes(120 * 1024 * 1024), "120MB");
});

test("levelsParam: 全選択・未選択は絞り込みなし", () => {
  assert.equal(levelsParam(new Set()), undefined);
  assert.equal(levelsParam(new Set(["error", "warn", "info", "debug"] as const)), undefined);
  assert.equal(levelsParam(new Set(["warn", "error"] as const)), "error,warn");
});

test("classifyLogError", () => {
  assert.equal(classifyLogError(404), "missing");
  assert.equal(classifyLogError(403), "denied");
  assert.equal(classifyLogError(500), "other");
  assert.equal(classifyLogError(undefined), "other");
});

test("olderCount: 表示上限までの範囲で読み込む", () => {
  assert.equal(olderCount(500), OLDER_LINES);
  assert.equal(olderCount(MAX_ENTRIES - 100), 100);
  assert.equal(olderCount(MAX_ENTRIES), 0);
});
