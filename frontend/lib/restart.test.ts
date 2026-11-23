import assert from "node:assert/strict";
import { test } from "node:test";

import { restartSummary, secondsUntil, type ServiceRestart } from "./restart.ts";

const r = (id: string, state: ServiceRestart["state"]): ServiceRestart => ({
  app_id: "a",
  service_id: id,
  state,
  attempts: 0,
  max_retries: 5,
  last_attempt_at: null,
  next_attempt_at: null,
  message: null,
});

test("restartSummary", () => {
  const m = {
    "a/web": r("web", "gave_up"),
    "a/db": r("db", "retrying"),
    "a/x": r("x", "watching"),
    "b/web": r("web", "gave_up"),
  };
  const s = restartSummary("a", ["web", "db", "x", "none"], m);
  assert.deepEqual(
    s.gaveUp.map((x) => x.service_id),
    ["web"],
  );
  assert.deepEqual(
    s.retrying.map((x) => x.service_id),
    ["db"],
  );
});

test("secondsUntil", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(secondsUntil("2026-01-01T00:00:13Z", now), 13);
  assert.equal(secondsUntil("2025-12-31T23:59:50Z", now), -10);
  assert.equal(secondsUntil(null, now), null);
  assert.equal(secondsUntil("x", now), null);
});
