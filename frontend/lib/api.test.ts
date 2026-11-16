import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUrl } from "./api.ts";

test("buildUrl drops null/undefined", () => {
  assert.equal(buildUrl("/api/x", { a: 1, b: null, c: undefined, d: "z" }), "/api/x?a=1&d=z");
});

test("buildUrl without query", () => {
  assert.equal(buildUrl("/api/x"), "/api/x");
  assert.equal(buildUrl("/api/x", { a: null }), "/api/x");
});
