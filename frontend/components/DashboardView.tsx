"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AppWindow,
  Check,
  ChevronRight,
  CircleDashed,
  RefreshCw,
  Square,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { HealthBadge } from "@/components/apps/HealthParts";
import { JobBadge } from "@/components/apps/ScheduledParts";
import { Badge, Spinner, fmtTime, type Tone } from "@/components/apps/parts";
import { useDashboardData } from "@/components/dashboard/useDashboardData";
import { useShellStatus } from "@/components/shell/ShellStatus";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import type { AppStatus } from "@/lib/apps";
import {
  ATTENTION_LABEL,
  appsHref,
  buildAttention,
  dashAppStatus,
  healthRows,
  miniCells,
  summarize,
  type AttentionItem,
  type DashApp,
} from "@/lib/dashboard";
import { ago, hkey, type HealthSample } from "@/lib/health";
import type { ScheduledJob } from "@/lib/scheduled";

const CARD = "border border-primary/30 bg-background/70 p-5";
const GO = "px-4 py-1.5 text-xs";

const APP_ST: Record<AppStatus, { label: string; tone: Tone; Icon: typeof Check | null }> = {
  running: { label: "実行中", tone: "ok", Icon: Check },
  stopped: { label: "停止中", tone: "muted", Icon: Square },
  partial: { label: "一部起動", tone: "warn", Icon: CircleDashed },
  busy: { label: "操作中", tone: "primary", Icon: null },
  error: { label: "エラー", tone: "danger", Icon: TriangleAlert },
};

function AppBadge({ status }: { status: AppStatus }) {
  const m = APP_ST[status];
  return (
    <Badge tone={m.tone}>
      {m.Icon ? <m.Icon size={13} aria-hidden="true" /> : <Spinner size={13} />}
      <span>{m.label}</span>
    </Badge>
  );
}

/** 情報源の取得失敗を、そのブロックだけに表示する。 */
function Unavailable({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="border-primary/30 flex flex-wrap items-center gap-3 border border-dashed p-4"
    >
      <Unplug size={18} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <strong>{what}を取得できません</strong>
        <p className="text-foreground/70 text-xs">このブロック以外の表示は利用できます。</p>
      </div>
      <Button type="button" className={GO} onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" />
        <span className="ms-1.5">再試行</span>
      </Button>
    </div>
  );
}

function GoButton({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Button type="button" className={GO} aria-label={label} onClick={() => router.push(href)}>
      <span>{children}</span>
      <ChevronRight size={15} aria-hidden="true" className="ms-1" />
    </Button>
  );
}

const TILES = [
  { k: "total", label: "登録アプリ", cls: "text-sky-300" },
  { k: "running", label: "実行中", cls: "text-teal-300" },
  { k: "stopped", label: "停止中", cls: "text-foreground/80" },
  { k: "partial", label: "一部起動", cls: "text-amber-300" },
] as const;

function MiniStrip({ hist }: { hist: HealthSample[] | undefined }) {
  const { cells, ok, total } = miniCells(hist);
  return (
    <span
      role="img"
      aria-label={total ? `直近 ${total} 件: 成功 ${ok} 件、失敗 ${total - ok} 件` : "履歴なし"}
      className="flex items-center gap-1.5"
    >
      <span className="flex items-end gap-px" aria-hidden="true">
        {cells.map((c, i) => (
          <span
            key={i}
            title={
              c
                ? `${new Date(c.checked_at).toLocaleString("ja-JP")} ${c.ok ? "成功" : "失敗"}`
                : undefined
            }
            className={`w-1 ${c ? (c.ok ? "bg-success h-3.5" : "bg-destructive h-2") : "bg-foreground/15 h-3.5"}`}
          />
        ))}
      </span>
      <span className="text-foreground/60 w-9 text-xs tabular-nums" aria-hidden="true">
        {total ? `${ok}/${total}` : "—"}
      </span>
    </span>
  );
}

function AttentionBadge({ it }: { it: AttentionItem }) {
  if (it.kind === "health") return <HealthBadge state="unhealthy" err={false} />;
  if (it.kind === "job-failed") return <JobBadge state="failed" err={false} />;
  if (it.kind === "job-overdue") return <JobBadge state="overdue" err={false} />;
  return (
    <Badge tone={it.kind === "retrying" ? "warn" : "danger"}>
      {it.kind === "retrying" ? (
        <Spinner size={12} />
      ) : (
        <TriangleAlert size={12} aria-hidden="true" />
      )}
      <span>{it.kind === "retrying" ? "試行中" : "上限到達"}</span>
    </Badge>
  );
}

function Block({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={CARD} aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-lg font-bold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Skeleton() {
  const bar = "bg-foreground/10 animate-pulse";
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">ダッシュボードを読み込み中です</span>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="border-primary/30 border p-4">
            <div className={`${bar} h-3.5 w-3/5`} />
            <div className={`${bar} mt-3 h-7 w-10`} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-6 grid gap-6 lg:grid-cols-2">
        {[0, 1].map((c) => (
          <div key={c} className="flex flex-col gap-6">
            {[0, 1].map((i) => (
              <div key={i} className={CARD}>
                <div className={`${bar} h-5 w-1/3`} />
                {[0, 1, 2].map((j) => (
                  <div key={j} className={`${bar} mt-3 h-10`} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardView() {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const d = useDashboardData(paused);
  const { setStatus } = useShellStatus();
  const { screen, refresh } = d;

  useEffect(() => {
    setStatus({
      lastUpdated: d.lastUpdated,
      refreshing: d.refreshing,
      paused,
      pollErr: d.pollErr,
      cycle: d.cycle,
      active: screen === "normal",
      errorCount: 0,
      connError: screen === "error",
      onRefresh: () => void refresh(),
      onTogglePause: () => setPaused((p) => !p),
    });
  }, [setStatus, d.lastUpdated, d.refreshing, paused, d.pollErr, d.cycle, screen, refresh]);
  useEffect(() => () => setStatus(null), [setStatus]);

  const head = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-primary-foreground text-2xl font-bold tracking-widest">DASHBOARD</h1>
        {screen === "normal" && (
          <p className="text-foreground/80 mt-1">
            参照専用の概要です。起動・停止などの操作は APPS で行います。
          </p>
        )}
      </div>
      <Button type="button" className={GO} onClick={() => router.push("/apps")}>
        <AppWindow size={14} aria-hidden="true" />
        <span className="ms-1.5">APPS を開く</span>
      </Button>
    </div>
  );

  if (screen === "loading") {
    return (
      <div>
        {head}
        <Skeleton />
      </div>
    );
  }
  if (screen === "empty") {
    return (
      <div>
        {head}
        <EmptyState
          title="アプリが登録されていません"
          description="config/apps.yaml に管理したいアプリとサービスを定義し、APPS で設定を再読込してください。"
        >
          <Button type="button" onClick={() => router.push("/apps")}>
            <span>APPS を開く</span>
          </Button>
        </EmptyState>
      </div>
    );
  }
  if (screen === "error" || !d.apps) {
    return (
      <div>
        {head}
        <ErrorState
          title="バックエンドに接続できません"
          description="thoth のバックエンドに接続できませんでした。バックエンドが起動しているか確認してください。"
          retryLabel={d.refreshing ? "接続を再試行中…" : "再試行"}
          onRetry={() => {
            if (!d.refreshing) d.retry();
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {head}
      <Normal apps={d.apps} d={d} />
    </div>
  );
}

function Normal({ apps, d }: { apps: DashApp[]; d: ReturnType<typeof useDashboardData> }) {
  const now = d.lastUpdated?.getTime() ?? 0;
  const counts = summarize(apps);
  const src = {
    health: d.health,
    healthErr: d.healthErr,
    restart: d.restart,
    restartErr: d.restartErr,
    jobs: d.jobs,
    jobsErr: d.jobsErr,
  };
  const att = buildAttention(apps, src);
  const { rows, counts: hc } = healthRows(apps, d.health);
  const jobRows: { app: DashApp; id: string; name: string; job: ScheduledJob | undefined }[] = [];
  for (const a of apps)
    for (const s of a.def.services)
      if (s.kind === "scheduled")
        jobRows.push({ app: a, id: s.id, name: s.name || s.id, job: d.jobs[hkey(a.def.id, s.id)] });
  const missing = [
    d.healthErr && "ヘルスチェック",
    d.restartErr && "自動再起動",
    d.jobsErr && "定期ジョブ",
  ].filter(Boolean);
  const retry = () => void d.refresh();

  return (
    <div className="flex flex-col gap-6">
      {d.pollErr > 0 && (
        <div
          role="alert"
          className="border-destructive/60 bg-destructive/10 flex flex-wrap items-center gap-3 border p-4"
        >
          <TriangleAlert size={20} className="text-rose-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <strong>状態の更新に失敗しました(連続 {d.pollErr} 回)</strong>
            <p className="text-foreground/70 text-xs">
              表示中の状態は {fmtTime(d.lastUpdated)}{" "}
              時点のものです。バックエンドを確認してください。
            </p>
          </div>
          <Button type="button" className={GO} onClick={retry} disabled={d.refreshing}>
            {d.refreshing ? <Spinner /> : <RefreshCw size={14} aria-hidden="true" />}
            <span className="ms-1.5">再試行</span>
          </Button>
        </div>
      )}

      <section aria-labelledby="sum-t">
        <h2 id="sum-t" className="sr-only">
          全体サマリ
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {TILES.map((t) => (
            <li key={t.k} className="border-primary/30 bg-background/70 border p-4">
              <span className="text-foreground/70 text-xs">{t.label}</span>
              <p className={`text-3xl font-bold tabular-nums ${t.cls}`}>{counts[t.k]}</p>
            </li>
          ))}
        </ul>
        <p className="text-foreground/70 mt-3 text-xs">
          サービス稼働{" "}
          <b className="tabular-nums">
            {counts.svcRunning}/{counts.svcTotal}
          </b>
          {counts.busy > 0 && <> ・ 操作中のアプリ {counts.busy}</>} ・ 定期ジョブ {counts.jobs}
          (稼働/停止の集計には含めません)
        </p>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Block
            id="att-t"
            title="要対応"
            aside={
              att.length > 0 ? (
                <Badge tone="danger">
                  <TriangleAlert size={12} aria-hidden="true" />
                  <span>{att.length} 件</span>
                </Badge>
              ) : null
            }
          >
            {missing.length > 0 && (
              <p
                role="status"
                className="text-foreground/70 mb-3 flex items-center gap-1.5 text-xs"
              >
                <Unplug size={13} aria-hidden="true" />
                {missing.join("・")}を取得できないため含まれていません
              </p>
            )}
            {att.length === 0 ? (
              <p className="text-foreground/80 flex items-center gap-2 text-sm">
                <Check size={16} className="text-teal-300" aria-hidden="true" />
                要対応はありません
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {att.map((it) => (
                  <li
                    key={it.id}
                    className={`flex flex-wrap items-center gap-3 border-l-4 ps-3 ${
                      it.sev === 0 || it.sev === 2 ? "border-l-destructive" : "border-l-amber-400"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-foreground/70">{ATTENTION_LABEL[it.kind]}</span>
                        <AttentionBadge it={it} />
                      </div>
                      <p className="mt-1 font-bold break-words">
                        {it.appName} / {it.serviceName}
                      </p>
                      <p className="text-foreground/70 text-xs break-words">{it.message}</p>
                    </div>
                    <GoButton
                      href={appsHref(it.appId, it.serviceId)}
                      label={`${it.appName} / ${it.serviceName} の${ATTENTION_LABEL[it.kind]}を APPS で確認`}
                    >
                      APPS で確認
                    </GoButton>
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block id="apps-t" title="アプリごとの状態">
            <ul className="flex flex-col gap-3">
              {apps.map((a) => {
                const sup = a.def.services.filter(
                  (s) =>
                    s.kind !== "scheduled" &&
                    (a.statuses.find((x) => x.service_id === s.id)?.state ?? "unsupported") !==
                      "unsupported",
                );
                const run = sup.filter(
                  (s) => a.statuses.find((x) => x.service_id === s.id)?.state === "running",
                ).length;
                const jc = a.def.services.filter((s) => s.kind === "scheduled").length;
                const n = att.filter((x) => x.appId === a.def.id).length;
                return (
                  <li
                    key={a.def.id}
                    className="border-primary/20 flex flex-wrap items-center gap-3 border-s-4 ps-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold break-all">{a.def.name}</span>
                        <AppBadge status={dashAppStatus(a)} />
                      </div>
                      <p className="text-foreground/70 mt-1 flex flex-wrap items-center gap-x-4 text-xs">
                        <span>
                          稼働{" "}
                          <b className="tabular-nums">
                            {run}/{sup.length}
                          </b>{" "}
                          サービス
                        </span>
                        {jc > 0 && <span>定期ジョブ {jc}</span>}
                        {n > 0 ? (
                          <span className="flex items-center gap-1 text-rose-300">
                            <TriangleAlert size={12} aria-hidden="true" />
                            要対応 {n} 件
                          </span>
                        ) : (
                          !d.healthErr &&
                          !d.restartErr &&
                          !d.jobsErr && (
                            <span className="flex items-center gap-1 text-teal-300">
                              <Check size={12} aria-hidden="true" />
                              要対応なし
                            </span>
                          )
                        )}
                      </p>
                    </div>
                    <GoButton href={appsHref(a.def.id)} label={`${a.def.name} を APPS で開く`}>
                      APPS
                    </GoButton>
                  </li>
                );
              })}
            </ul>
          </Block>
        </div>

        <div className="flex flex-col gap-6">
          <Block
            id="hc-t"
            title="ヘルスチェックの直近状態"
            aside={
              !d.healthErr && (
                <span className="text-foreground/70 text-xs">
                  正常 {hc.healthy} ・ 異常 {hc.unhealthy}
                  {hc.starting > 0 && <> ・ 起動中 {hc.starting}</>} ・ 不明 {hc.unknown}
                </span>
              )
            }
          >
            {d.healthErr ? (
              <Unavailable what="ヘルスチェックの状態" onRetry={retry} />
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {rows.map((r) => (
                    <li
                      key={`${r.appId}/${r.serviceId}`}
                      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto_auto_4.5rem] ${
                        r.state === "unhealthy" ? "text-rose-300" : ""
                      }`}
                    >
                      <span className="truncate text-sm" title={r.health?.message ?? undefined}>
                        {r.appName} / {r.serviceName}
                      </span>
                      <HealthBadge state={r.state} err={false} />
                      <span className="col-span-2 sm:col-span-1">
                        <MiniStrip hist={d.history[hkey(r.appId, r.serviceId)]} />
                      </span>
                      <span className="text-foreground/60 col-span-2 text-xs sm:col-span-1 sm:text-right">
                        {r.health?.checked_at ? ago(r.health.checked_at, now) : "未チェック"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-foreground/60 mt-3 text-xs">
                  直近 10 件の結果(左が古く → 右が新しい)。緑の棒=成功、赤い短い棒=失敗。
                </p>
              </>
            )}
          </Block>

          <Block id="job-t" title="定期ジョブ">
            {d.jobsErr ? (
              <Unavailable what="定期ジョブの状態" onRetry={retry} />
            ) : jobRows.length === 0 ? (
              <p className="text-foreground/70 text-sm">定期ジョブは登録されていません</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {jobRows.map((r) => {
                  const bad = r.job?.state === "failed" || r.job?.state === "overdue";
                  return (
                    <li
                      key={`${r.app.def.id}/${r.id}`}
                      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto_auto_4.5rem] ${
                        bad ? "text-rose-300" : ""
                      }`}
                    >
                      <span className="truncate text-sm">
                        {r.app.def.name} / {r.name}
                      </span>
                      <JobBadge state={r.job?.state} err={false} />
                      <span className="text-foreground/70 col-span-2 text-xs sm:col-span-1">
                        {r.job?.schedule ?? "—"}
                      </span>
                      <span className="text-foreground/60 col-span-2 text-xs sm:col-span-1 sm:text-right">
                        {r.job?.last_run_at ? ago(r.job.last_run_at, now) : "実行履歴なし"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Block>
        </div>
      </div>
    </div>
  );
}
