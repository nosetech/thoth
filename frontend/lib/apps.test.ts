import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "./api.ts";
import { errorMessage, needsConfirm, summarize, summarizeResults } from "./apps.ts";

test("needsConfirm: 起動のみ確認不要、一括は常に確認", () => {
  assert.equal(needsConfirm("start", "app"), false);
  assert.equal(needsConfirm("stop", "service"), true);
  assert.equal(needsConfirm("restart", "app"), true);
  assert.equal(needsConfirm("start", "bulk"), true);
});

test("summarize", () => {
  assert.equal(summarize([]), "unsupported");
  assert.equal(summarize(["unsupported"]), "unsupported");
  assert.equal(summarize(["running", "running", "unsupported"]), "running");
  assert.equal(summarize(["running", "stopped"]), "partial");
  assert.equal(summarize(["stopped"]), "stopped");
});

test("errorMessage: 文字列 detail / results / その他", () => {
  assert.equal(errorMessage(new ApiError(409, { detail: "実行中です" })), "実行中です");
  assert.equal(
    errorMessage(
      new ApiError(500, {
        detail: {
          results: [{ service_id: "a", action: "start", result: "error", message: "失敗" }],
        },
      }),
    ),
    "a: 失敗",
  );
  assert.equal(errorMessage(new ApiError(500, "x")), "x");
  assert.equal(errorMessage(new ApiError(500, null)), "操作に失敗しました (HTTP 500)");
  assert.equal(errorMessage(new Error("net")), "backend に接続できません");
});

test("summarizeResults", () => {
  const r = (result: "ok" | "skipped" | "error") => ({
    service_id: "s",
    action: "start",
    result,
    message: null,
  });
  assert.deepEqual(summarizeResults([r("ok"), r("ok"), r("error"), r("skipped")]), {
    ok: 2,
    skipped: 1,
    error: 1,
  });
});
