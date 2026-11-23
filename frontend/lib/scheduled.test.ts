import assert from "node:assert/strict";
import { test } from "node:test";

import { abnormalJobs, isScheduledAbnormal, type ScheduledJob } from "./scheduled.ts";

const j = (app: string, id: string, state: ScheduledJob["state"]): ScheduledJob => ({
  app_id: app,
  service_id: id,
  state,
  message: "",
  schedule: null,
  expected_interval: null,
  last_run_at: null,
  exit_code: null,
});

test("失敗と遅延だけが異常", () => {
  for (const s of ["failed", "overdue"] as const) assert.equal(isScheduledAbnormal(s), true);
  for (const s of ["ok", "running", "never", "unloaded", "unknown"] as const)
    assert.equal(isScheduledAbnormal(s), false);
  assert.equal(isScheduledAbnormal(undefined), false);
});

test("abnormalJobs: 対象アプリの異常のみ", () => {
  const map = {
    "a/x": j("a", "x", "failed"),
    "a/y": j("a", "y", "ok"),
    "b/x": j("b", "x", "overdue"),
  };
  assert.deepEqual(
    abnormalJobs("a", map).map((v) => v.service_id),
    ["x"],
  );
});
