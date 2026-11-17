import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_ITEMS, isActive } from "./nav.ts";

test("isActive: ルートは完全一致のみ", () => {
  assert.equal(isActive("/", "/"), true);
  assert.equal(isActive("/apps", "/"), false);
});

test("isActive: 配下のパスも該当する", () => {
  assert.equal(isActive("/apps", "/apps"), true);
  assert.equal(isActive("/apps/producer-desk", "/apps"), true);
});

test("isActive: 前方一致だけでは該当しない", () => {
  assert.equal(isActive("/apps-old", "/apps"), false);
});

test("NAV_ITEMS: href が一意", () => {
  const hrefs = NAV_ITEMS.map((i) => i.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test("isActive: 末尾スラッシュ付きと深い階層", () => {
  assert.equal(isActive("/logs/", "/logs"), true);
  assert.equal(isActive("/logs/a/b", "/logs"), true);
  assert.equal(isActive("/", "/apps"), false);
});
