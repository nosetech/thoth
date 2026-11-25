import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appsHref,
  attentionHref,
  buildAttention,
  dashAppStatus,
  hashToElementId,
  healthRows,
  miniCells,
  serviceElementId,
  summarize,
  type DashApp,
  type Sources,
} from "./dashboard.ts";
import type { ServiceHealth } from "./health.ts";
import type { ServiceRestart } from "./restart.ts";
import type { ScheduledJob } from "./scheduled.ts";

const svc = (id: string, kind = "process") => ({ id, name: id, kind, depends_on: [] });
const st = (
  id: string,
  state: "running" | "stopped" | "unsupported",
  busy: string | null = null,
) => ({
  service_id: id,
  kind: "process",
  state,
  pid: null,
  busy,
});
const app = (
  id: string,
  services: ReturnType<typeof svc>[],
  statuses: ReturnType<typeof st>[],
): DashApp => ({
  def: { id, name: id, description: null, modes: ["local"], services },
  statuses,
});

const apps: DashApp[] = [
  app("a", [svc("web"), svc("api")], [st("web", "running"), st("api", "running")]),
  app("b", [svc("web"), svc("api")], [st("web", "running"), st("api", "stopped")]),
  app("c", [svc("web")], [st("web", "stopped")]),
  app(
    "d",
    [svc("node", "systemd"), svc("job", "scheduled"), svc("web")],
    [st("node", "unsupported"), st("web", "running")],
  ),
];

const empty: Sources = {
  health: {},
  healthErr: false,
  restart: {},
  restartErr: false,
  jobs: {},
  jobsErr: false,
};
const h = (a: string, s: string, state: ServiceHealth["state"]): ServiceHealth => ({
  app_id: a,
  service_id: s,
  state,
  message: "HTTP 500",
  checked_at: null,
});
const job = (a: string, s: string, state: ScheduledJob["state"]): ScheduledJob => ({
  app_id: a,
  service_id: s,
  state,
  message: "msg",
  schedule: null,
  expected_interval: null,
  last_run_at: null,
  exit_code: null,
});
const rs = (a: string, s: string, state: ServiceRestart["state"]): ServiceRestart => ({
  app_id: a,
  service_id: s,
  state,
  attempts: 2,
  max_retries: 5,
  last_attempt_at: null,
  next_attempt_at: null,
  message: null,
});

test("dashAppStatus: 操作中・全稼働・一部・停止", () => {
  assert.equal(dashAppStatus(apps[0]), "running");
  assert.equal(dashAppStatus(apps[1]), "partial");
  assert.equal(dashAppStatus(apps[2]), "stopped");
  assert.equal(dashAppStatus(app("x", [svc("w")], [st("w", "running", "restart")])), "busy");
});

test("summarize: 未対応と定期ジョブはサービス集計に含めない", () => {
  const c = summarize(apps);
  assert.deepEqual(
    [c.total, c.running, c.partial, c.stopped, c.busy, c.svcRunning, c.svcTotal, c.jobs],
    [4, 2, 1, 1, 0, 4, 6, 1],
  );
});

test("buildAttention: 急ぐ順に並び、取得できない情報源は含めない", () => {
  const src: Sources = {
    ...empty,
    health: { "a/web": h("a", "web", "unhealthy"), "b/web": h("b", "web", "healthy") },
    restart: { "b/web": rs("b", "web", "gave_up"), "a/api": rs("a", "api", "retrying") },
    jobs: { "d/job": job("d", "job", "failed") },
  };
  const items = buildAttention(apps, src);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["restart-gave-up", "health", "job-failed", "retrying"],
  );
  const err = buildAttention(apps, { ...src, healthErr: true, restartErr: true, jobsErr: true });
  assert.equal(err.length, 0);
});

test("buildAttention: 停止中サービスのヘルス異常と正常な定期ジョブは対象外", () => {
  const src: Sources = {
    ...empty,
    health: { "b/api": h("b", "api", "unhealthy") },
    jobs: { "d/job": job("d", "job", "ok") },
  };
  assert.equal(buildAttention(apps, src).length, 0);
});

test("healthRows: 定期ジョブ・未対応を除き状態ごとに数える", () => {
  const { rows, counts } = healthRows(apps, { "a/web": h("a", "web", "healthy") });
  assert.equal(rows.length, 6);
  assert.equal(counts.healthy, 1);
  assert.equal(counts.unknown, 5);
});

test("miniCells: 左を空きで埋め、古い順に並べる", () => {
  const hist = [
    { ok: true, message: null, checked_at: "2026-01-01T00:00:02Z" },
    { ok: false, message: null, checked_at: "2026-01-01T00:00:01Z" },
  ];
  const m = miniCells(hist, 4);
  assert.equal(m.cells.length, 4);
  assert.equal(m.cells[0], null);
  assert.equal(m.cells[2]?.ok, false);
  assert.equal(m.cells[3]?.ok, true);
  assert.deepEqual([m.ok, m.total], [1, 2]);
  assert.equal(miniCells(undefined).total, 0);
});

test("appsHref と hashToElementId は往復できる", () => {
  assert.equal(appsHref("media-vault"), "/apps#app-media-vault");
  const href = appsHref("my app", "web");
  assert.equal(hashToElementId(href.slice(href.indexOf("#"))), serviceElementId("my app", "web"));
  assert.equal(hashToElementId("#app-a"), "app-a");
  assert.equal(hashToElementId("#other"), null);
  assert.equal(hashToElementId("#app-%E0%A4%A"), null);
});

test("buildAttention: 未確認の検知があるサービスを ERRORS への項目にする", () => {
  const det = (app_id: string, service_id: string, error: number, warn: number) => ({
    app_id,
    app_name: app_id,
    service_id,
    service_name: service_id,
    unacknowledged: error + warn,
    error,
    warn,
    latest_at: "2026-11-25T00:00:00Z",
    latest_line: "x".repeat(200),
    latest_severity: "error" as const,
  });
  const items = buildAttention(apps, {
    ...empty,
    errors: [det("a", "web", 2, 1), det("b", "api", 0, 3), det("zz", "web", 1, 0)],
  });
  const logs = items.filter((i) => i.kind === "log-errors");
  assert.deepEqual(
    logs.map((i) => [i.appId, i.serviceId, i.errors?.count, i.errors?.severity, i.sev]),
    [
      ["a", "web", 3, "error", 2],
      ["b", "api", 3, "warn", 3],
    ],
  ); // 未登録のアプリ（zz）は含めない
  assert.equal(logs[0].message.length, 121);
  assert.equal(attentionHref(logs[0]), "/errors?app=a&service=web");
  assert.equal(
    buildAttention(apps, { ...empty, errors: [det("a", "web", 1, 0)], errorsErr: true }).length,
    0,
  );
});
