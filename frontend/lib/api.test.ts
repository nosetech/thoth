import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, apiFetch, buildUrl } from "./api.ts";

test("buildUrl drops null/undefined", () => {
  assert.equal(buildUrl("/api/x", { a: 1, b: null, c: undefined, d: "z" }), "/api/x?a=1&d=z");
});

test("buildUrl without query", () => {
  assert.equal(buildUrl("/api/x"), "/api/x");
  assert.equal(buildUrl("/api/x", { a: null }), "/api/x");
});

async function withFetch(res: Response, fn: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test("apiFetch throws ApiError with status for non-JSON error body", async () => {
  await withFetch(new Response("Internal Server Error", { status: 500 }), async () => {
    await assert.rejects(apiFetch("/api/x"), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 500);
      assert.equal(e.body, "Internal Server Error");
      return true;
    });
  });
});

test("apiFetch throws ApiError with parsed body for JSON error", async () => {
  await withFetch(new Response('{"detail":"x"}', { status: 404 }), async () => {
    await assert.rejects(apiFetch("/api/x"), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 404);
      assert.deepEqual(e.body, { detail: "x" });
      return true;
    });
  });
});

test("apiFetch returns parsed JSON on success", async () => {
  await withFetch(new Response('{"a":1}', { status: 200 }), async () => {
    assert.deepEqual(await apiFetch("/api/x"), { a: 1 });
  });
});
