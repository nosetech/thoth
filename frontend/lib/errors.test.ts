import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_FILTER,
  errorsHref,
  filterFromSearch,
  filterQuery,
  isFiltered,
  logTargetFromSearch,
  logsHref,
  relTime,
  unackByApp,
  type ErrorSummary,
} from "./errors.ts";

test("filterQuery は空の条件を送らない", () => {
  assert.deepEqual(filterQuery(EMPTY_FILTER), {
    app_id: undefined,
    service_id: undefined,
    rule_id: undefined,
    severity: undefined,
    include_acknowledged: undefined,
    limit: 200,
  });
  const q = filterQuery({ app: "a", service: "s", rule: "r", severity: "warn", includeAck: true });
  assert.equal(q.app_id, "a");
  assert.equal(q.severity, "warn");
  assert.equal(q.include_acknowledged, true);
});

test("isFiltered は確認済みの表示切替を絞り込みとみなさない", () => {
  assert.equal(isFiltered({ ...EMPTY_FILTER, includeAck: true }), false);
  assert.equal(isFiltered({ ...EMPTY_FILTER, rule: "r" }), true);
});

test("errorsHref と filterFromSearch は往復できる", () => {
  assert.equal(errorsHref(), "/errors");
  const href = errorsHref("deep tracker", "back/end");
  const f = filterFromSearch(href.slice(href.indexOf("?")));
  assert.equal(f.app, "deep tracker");
  assert.equal(f.service, "back/end");
  // アプリ無しのサービス指定は無視する
  assert.equal(filterFromSearch("?service=x").service, "");
});

test("logsHref と logTargetFromSearch は往復できる", () => {
  const href = logsHref({ app_id: "a", service_id: "s", source: 1, file_name: "app.log.1" });
  assert.deepEqual(logTargetFromSearch(href.slice(href.indexOf("?"))), {
    app: "a",
    service: "s",
    source: 1,
    file: "app.log.1",
  });
  assert.equal(logTargetFromSearch("?app=a"), null);
  assert.equal(logTargetFromSearch("?app=a&service=s&source=x")?.source, null);
});

test("relTime", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(relTime("2026-11-25T11:59:30Z", now), "30 秒前");
  assert.equal(relTime("2026-11-25T11:55:00Z", now), "5 分前");
  assert.equal(relTime("2026-11-25T09:00:00Z", now), "3 時間前");
  assert.equal(relTime("2026-11-23T12:00:00Z", now), "2 日前");
  assert.equal(relTime("2026-11-25T12:00:05Z", now), "0 秒前");
});

test("unackByApp はアプリごとに合算して多い順に並べる", () => {
  const svc = (app: string, error: number, warn: number) => ({
    app_id: app,
    app_name: app.toUpperCase(),
    service_id: "s",
    service_name: "s",
    unacknowledged: error + warn,
    error,
    warn,
    latest_at: "2026-11-25T00:00:00Z",
    latest_line: "",
    latest_severity: "error" as const,
  });
  const s: ErrorSummary = {
    unacknowledged: 0,
    error: 0,
    warn: 0,
    last_detected_at: null,
    services: [svc("a", 1, 0), svc("b", 2, 1), svc("a", 0, 1)],
  };
  assert.deepEqual(unackByApp(s), [
    { app_id: "b", app_name: "B", error: 2, warn: 1 },
    { app_id: "a", app_name: "A", error: 1, warn: 1 },
  ]);
});
