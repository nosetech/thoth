import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBackendUrl, buildForwardHeaders } from "./proxy.ts";

const B = "http://127.0.0.1:8900";

test("buildBackendUrl joins and encodes segments", () => {
  assert.equal(buildBackendUrl(B, ["apps", "1"], "?a=1"), `${B}/api/apps/1?a=1`);
  assert.equal(buildBackendUrl(B, ["a?b", "c#d"], ""), `${B}/api/a%3Fb/c%23d`);
});

test("buildBackendUrl rejects dot / empty segments", () => {
  assert.equal(buildBackendUrl(B, ["..", "admin"], ""), null);
  assert.equal(buildBackendUrl(B, ["."], ""), null);
  assert.equal(buildBackendUrl(B, ["a", ""], ""), null);
});

test("buildBackendUrl keeps encoded slash inside one segment", () => {
  assert.equal(buildBackendUrl(B, ["a/b"], ""), `${B}/api/a%2Fb`);
});

test("buildForwardHeaders forwards only present headers", () => {
  assert.deepEqual(buildForwardHeaders(new Headers(), true), {});
  assert.deepEqual(
    buildForwardHeaders(
      new Headers({ "content-type": "application/json", accept: "text/plain" }),
      true,
    ),
    { "content-type": "application/json", accept: "text/plain" },
  );
});

test("buildForwardHeaders skips content-type without body", () => {
  assert.deepEqual(buildForwardHeaders(new Headers({ "content-type": "x", accept: "y" }), false), {
    accept: "y",
  });
});
