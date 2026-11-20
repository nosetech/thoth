import assert from "node:assert/strict";
import { test } from "node:test";

import { ago, healthSummary, stripCells, type ServiceHealth } from "./health.ts";

const h = (id: string, state: ServiceHealth["state"]): ServiceHealth => ({
  app_id: "a",
  service_id: id,
  state,
  message: null,
  checked_at: null,
});

test("ago", () => {
  const now = Date.parse("2026-01-01T00:10:00Z");
  assert.equal(ago("2026-01-01T00:09:58Z", now), "たった今");
  assert.equal(ago("2026-01-01T00:09:30Z", now), "30 秒前");
  assert.equal(ago("2026-01-01T00:05:00Z", now), "5 分前");
  assert.equal(ago("2025-12-30T00:10:00Z", now), "2 日前");
  assert.equal(ago("x", now), "—");
});

test("healthSummary: 実行中のみ集計、未取得は不明", () => {
  const map = {
    "a/web": h("web", "unhealthy"),
    "a/api": h("api", "healthy"),
    "a/db": h("db", "starting"),
  };
  const s = healthSummary("a", ["web", "api", "db", "x"], map);
  assert.deepEqual(
    { u: s.unhealthy.length, h: s.healthy, st: s.starting, k: s.unknown, r: s.running },
    { u: 1, h: 1, st: 1, k: 1, r: 4 },
  );
});

test("stripCells: 古い順に並べ、足りない分は左を null で埋める", () => {
  const mk = (i: number) => ({ ok: true, message: String(i), checked_at: "t" });
  const cells = stripCells([mk(2), mk(1)], 4);
  assert.equal(cells.length, 4);
  assert.deepEqual(
    cells.map((c) => c?.message ?? null),
    [null, null, "1", "2"],
  );
});
