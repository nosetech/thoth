import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "./api.ts";
import { appStatus, countResults, errorMessage, isBulkTarget, topo } from "./apps.ts";

test("appStatus: busy > error > 稼働状況、未対応は除外", () => {
  assert.equal(appStatus(["running"], true, true), "busy");
  assert.equal(appStatus(["running"], false, true), "error");
  assert.equal(appStatus(["running", "unsupported"], false, false), "running");
  assert.equal(appStatus(["running", "stopped"], false, false), "partial");
  assert.equal(appStatus(["stopped", "unsupported"], false, false), "stopped");
  assert.equal(appStatus(["unsupported"], false, false), "stopped");
});

test("isBulkTarget", () => {
  assert.equal(isBulkTarget(["stopped", "running"], "start"), true);
  assert.equal(isBulkTarget(["running"], "start"), false);
  assert.equal(isBulkTarget(["running"], "stop"), true);
  assert.equal(isBulkTarget(["stopped", "unsupported"], "restart"), false);
});

test("topo: 依存先が先、循環しても落ちない", () => {
  const s = [
    { id: "web", depends_on: ["api"] },
    { id: "api", depends_on: [] },
  ];
  assert.deepEqual(
    topo(s).map((x) => x.id),
    ["api", "web"],
  );
  const c = [
    { id: "a", depends_on: ["b"] },
    { id: "b", depends_on: ["a"] },
  ];
  assert.equal(topo(c).length, 2);
});

test("errorMessage", () => {
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
  assert.equal(errorMessage(new ApiError(422, { detail: [{ msg: "x" }] })), "入力が不正です");
  assert.equal(errorMessage(new ApiError(500, null)), "操作に失敗しました (HTTP 500)");
  assert.equal(errorMessage(new Error("net")), "バックエンドに接続できません");
});

test("countResults", () => {
  const r = (result: "ok" | "skipped" | "error") => ({ result });
  assert.deepEqual(countResults([r("ok"), r("ok"), r("error"), r("skipped")]), {
    ok: 2,
    skipped: 1,
    error: 1,
  });
});
