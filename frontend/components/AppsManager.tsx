"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  CircleDashed,
  FileText,
  Info,
  Lock,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  TriangleAlert,
} from "lucide-react";
import { ConfirmDialog, type ConfirmCfg } from "@/components/apps/ConfirmDialog";
import { Badge, Spinner, fmtTime, type Tone } from "@/components/apps/parts";
import {
  OVERALL_LABEL,
  ResultBadge,
  ResultSheet,
  type BulkView,
} from "@/components/apps/ResultSheet";
import { useShellStatus } from "@/components/shell/ShellStatus";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  RadioGroupItem,
  RadioGroupItemControl,
  RadioGroupItemText,
  RadioGroupLabel,
  RadioGroupRoot,
} from "@/components/ui/radio-group";
import {
  createToaster,
  Toaster,
  ToastCloseTrigger,
  ToastDescription,
  ToastRoot,
  ToastTitle,
} from "@/components/ui/toast";
import { apiFetch } from "@/lib/api";
import {
  appStatus,
  countResults,
  errorMessage,
  isBulkTarget,
  MODES,
  OP,
  topo,
  type Action,
  type AppDef,
  type AppStatus,
  type BulkResult,
  type ModeInfo,
  type ServiceDef,
  type ServiceResult,
  type ServiceState,
  type ServiceStatus,
} from "@/lib/apps";

const POLL_MS = 5000;
const OPS: Action[] = ["start", "stop", "restart"];
function omit<T>(o: Record<string, T>, k: string): Record<string, T> {
  return Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));
}

const toaster = createToaster({ placement: "bottom-end", overlap: false, gap: 12 });

const OpIcon = { start: Play, stop: Square, restart: RotateCw };
const OP_VARIANT = { start: "success", stop: "destructive", restart: "secondary" } as const;

type AppView = { def: AppDef; statuses: ServiceStatus[]; mode: ModeInfo | null };
type Msg = { type: "ok" | "error" | "info"; text: string; at: Date };
type ToastType = "ok" | "error" | "info";

const APP_ST: Record<AppStatus, { label: string; tone: Tone; Icon: typeof Check | null }> = {
  running: { label: "実行中", tone: "ok", Icon: Check },
  stopped: { label: "停止中", tone: "muted", Icon: Square },
  partial: { label: "一部起動", tone: "warn", Icon: CircleDashed },
  busy: { label: "操作中", tone: "primary", Icon: null },
  error: { label: "エラー", tone: "danger", Icon: TriangleAlert },
};

const CARD_EDGE: Record<AppStatus, string> = {
  running: "border-l-success",
  stopped: "border-l-foreground/30",
  partial: "border-l-amber-400",
  busy: "border-l-primary",
  error: "border-l-destructive",
};

const BTN = "px-4 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40";
const CARD = "border border-primary/30 bg-background/70 p-5";
const IMPACT = "list-disc space-y-1 ps-5 text-xs";

function AppBadge({ status, op }: { status: AppStatus; op?: Action }) {
  const m = APP_ST[status];
  return (
    <Badge tone={m.tone}>
      {m.Icon ? <m.Icon size={13} aria-hidden="true" /> : <Spinner size={13} />}
      <span>
        {m.label}
        {status === "busy" && op ? `・${OP[op]}` : ""}
      </span>
    </Badge>
  );
}

function SvcBadge({ state, busy }: { state: ServiceState; busy?: Action }) {
  if (busy)
    return (
      <Badge tone="primary">
        <Spinner size={12} />
        <span>{OP[busy]}中…</span>
      </Badge>
    );
  const m: Record<ServiceState, { tone: Tone; Icon: typeof Check; ja: string }> = {
    running: { tone: "ok", Icon: Check, ja: "実行中" },
    stopped: { tone: "muted", Icon: Square, ja: "停止" },
    unsupported: { tone: "unsup", Icon: Ban, ja: "未対応" },
  };
  const x = m[state];
  return (
    <Badge tone={x.tone}>
      <x.Icon size={12} aria-hidden="true" />
      <span>{state}</span>
      <span className="sr-only">({x.ja})</span>
    </Badge>
  );
}

function OpButton({
  op,
  disabled,
  busy,
  onClick,
  label,
  reason,
}: {
  op: Action;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  label: string;
  reason: string | null;
}) {
  const Icon = OpIcon[op];
  return (
    <Button
      type="button"
      variant={OP_VARIANT[op]}
      className={BTN}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={disabled && reason ? reason : label}
    >
      {busy ? <Spinner size={14} /> : <Icon size={14} aria-hidden="true" />}
      <span className="ms-1.5">{OP[op]}</span>
    </Button>
  );
}

function Help({ warn, children }: { warn?: boolean; children: React.ReactNode }) {
  return (
    <p
      className={`flex items-start gap-1.5 text-xs ${warn ? "text-amber-300" : "text-foreground/70"}`}
    >
      {children}
    </p>
  );
}

function ModeSelector({
  view,
  lockReason,
  onChange,
}: {
  view: AppView;
  lockReason: string | null;
  onChange: (m: string) => void;
}) {
  const { def, mode } = view;
  const current = mode?.mode ?? "local";
  const unavailable = (m: string): string | null => {
    if (!def.modes.includes(m)) return "このアプリでは未定義です";
    const o = mode?.modes.find((x) => x.name === m);
    return o && !o.available ? (o.reason ?? "利用できません") : null;
  };
  return (
    <div className="flex flex-col gap-2">
      <RadioGroupRoot
        value={current}
        onValueChange={({ value }) => value && value !== current && onChange(value)}
        orientation="horizontal"
        className="flex-row flex-wrap items-center gap-x-5 gap-y-2"
      >
        <RadioGroupLabel className="text-xs">起動モード</RadioGroupLabel>
        {MODES.map((m) => {
          const un = unavailable(m);
          const reason = m === current ? null : (un ?? lockReason);
          return (
            <span key={m} title={reason ?? undefined}>
              <RadioGroupItem value={m} disabled={!!reason}>
                <RadioGroupItemControl />
                <RadioGroupItemText className="flex items-center gap-1">
                  {un && <Lock size={12} aria-hidden="true" />}
                  {m}
                </RadioGroupItemText>
              </RadioGroupItem>
            </span>
          );
        })}
      </RadioGroupRoot>
      {lockReason && (
        <Help warn>
          <Lock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {lockReason}
        </Help>
      )}
      {MODES.filter((m) => unavailable(m)).map((m) => (
        <Help key={m}>
          <Ban size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {m} は選択不可: {unavailable(m)}
          </span>
        </Help>
      ))}
    </div>
  );
}

export function AppsManager() {
  const [apps, setApps] = useState<AppView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [appBusy, setAppBusy] = useState<Record<string, Action>>({});
  const [svcBusy, setSvcBusy] = useState<Record<string, Action>>({});
  const [msgs, setMsgs] = useState<Record<string, Msg | null>>({});
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [modeBusy, setModeBusy] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState<Action | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkView | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [onFail, setOnFail] = useState<"continue" | "abort">("continue");
  const [paused, setPaused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [pollErr, setPollErr] = useState(0);
  const [reloading, setReloading] = useState(false);
  const mounted = useRef(true);
  const refreshing$ = useRef(false);
  const pendingRefresh = useRef(false);
  const refreshRef = useRef<(manual: boolean) => Promise<void>>(async () => {});
  const appsRef = useRef<AppView[] | null>(null);
  useEffect(() => {
    appsRef.current = apps;
  }, [apps]);

  const toast = useCallback((type: ToastType, title: string, text?: string) => {
    toaster.create({
      title,
      description: text,
      type: type === "ok" ? "success" : type,
      duration: type === "error" ? 8000 : 5000,
    });
  }, []);

  const load = useCallback(async (): Promise<AppView[]> => {
    const defs = await apiFetch<AppDef[]>("/api/apps");
    return Promise.all(
      defs.map(async (def): Promise<AppView> => {
        const [statuses, mode] = await Promise.all([
          apiFetch<ServiceStatus[]>(`/api/apps/${encodeURIComponent(def.id)}/status`).catch(
            () => appsRef.current?.find((v) => v.def.id === def.id)?.statuses ?? [],
          ),
          apiFetch<ModeInfo>(`/api/apps/${encodeURIComponent(def.id)}/mode`).catch(() => null),
        ]);
        return { def, statuses, mode };
      }),
    );
  }, []);

  const doRefresh = useCallback(
    async (manual: boolean) => {
      if (refreshing$.current) {
        // 取得中に要求された再取得は完了後にもう一度行う（操作直後の状態を取りこぼさない）
        pendingRefresh.current = true;
        return;
      }
      refreshing$.current = true;
      setRefreshing(true);
      try {
        const views = await load();
        if (!mounted.current) return;
        setApps(views);
        setLoadError(false);
        setPollErr(0);
        setLastUpdated(new Date());
        if (manual) toast("ok", "最新の状態に更新しました", fmtTime(new Date()));
      } catch {
        if (!mounted.current) return;
        if (appsRef.current === null) setLoadError(true);
        else {
          setPollErr((n) => n + 1);
          if (manual)
            toast("error", "状態の更新に失敗しました", "バックエンドから応答がありません");
        }
      } finally {
        refreshing$.current = false;
        if (pendingRefresh.current && mounted.current) {
          pendingRefresh.current = false;
          void refreshRef.current(false);
        }
        if (mounted.current) {
          setRefreshing(false);
          setCycle((c) => c + 1);
        }
      }
    },
    [load, toast],
  );

  useEffect(() => {
    refreshRef.current = doRefresh;
  }, [doRefresh]);

  const screen = loadError
    ? "error"
    : apps === null
      ? "loading"
      : apps.length === 0
        ? "empty"
        : "normal";

  useEffect(() => {
    mounted.current = true;
    const first = setTimeout(() => void doRefresh(false), 0);
    return () => {
      mounted.current = false;
      clearTimeout(first);
    };
  }, [doRefresh]);

  useEffect(() => {
    if (paused || screen !== "normal") return;
    const tick = () => document.visibilityState === "visible" && void doRefresh(false);
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [paused, screen, doRefresh]);

  const setMsg = (id: string, m: Msg | null) => setMsgs((s) => ({ ...s, [id]: m }));
  const states = (v: AppView) => v.statuses.map((s) => s.state);
  const anyBusy = Object.keys(appBusy).length > 0 || Object.keys(svcBusy).length > 0 || !!bulkBusy;
  const nameOf = (v: AppView, s: ServiceDef) => s.name || s.id;

  /** アプリ単位・サービス単位の操作を実行する。 */
  const run = async (v: AppView, op: Action, svc?: ServiceDef) => {
    const id = v.def.id;
    setAppBusy((b) => ({ ...b, [id]: op }));
    const key = svc ? `${id}/${svc.id}` : null;
    if (key) setSvcBusy((b) => ({ ...b, [key]: op }));
    setMsg(id, null);
    const label = svc ? `${v.def.name} / ${nameOf(v, svc)}` : v.def.name;
    try {
      if (svc) {
        await apiFetch(
          `/api/apps/${encodeURIComponent(id)}/services/${encodeURIComponent(svc.id)}/${op}`,
          { method: "POST" },
        );
        const text = `${nameOf(v, svc)} を${OP[op]}しました`;
        setMsg(id, { type: "ok", text, at: new Date() });
        toast("ok", label, text);
      } else {
        const r = await apiFetch<{ results: ServiceResult[] }>(
          `/api/apps/${encodeURIComponent(id)}/${op}`,
          {
            method: "POST",
          },
        );
        const c = countResults(r.results);
        const text =
          c.error > 0
            ? `${OP[op]}に失敗しました — ${r.results
                .filter((x) => x.result === "error")
                .map((x) => `${x.service_id}: ${x.message ?? ""}`)
                .join(" / ")}`
            : c.ok > 0
              ? `${c.ok} サービスを${OP[op]}しました${c.skipped ? `(${c.skipped} 件スキップ)` : ""}`
              : `${OP[op]}の対象となるサービスはありませんでした`;
        const type = c.error > 0 ? "error" : c.ok > 0 ? "ok" : "info";
        setMsg(id, { type, text, at: new Date() });
        if (type === "error") toast("error", `${label} の${OP[op]}に失敗`, text);
        else toast(type, label, text);
      }
    } catch (e) {
      const text = errorMessage(e);
      setMsg(id, { type: "error", text: `${OP[op]}に失敗しました — ${text}`, at: new Date() });
      toast("error", `${label} の${OP[op]}に失敗`, text);
    } finally {
      setAppBusy((b) => omit(b, id));
      if (key) setSvcBusy((b) => omit(b, key));
      await doRefresh(false);
    }
  };

  const onAppOp = (v: AppView, op: Action) => {
    if (op === "start") return void run(v, op);
    const running = v.def.services.filter(
      (s) => v.statuses.find((x) => x.service_id === s.id)?.state === "running",
    );
    setConfirm({
      title: `${v.def.name} を${OP[op]}しますか?`,
      destructive: true,
      confirmLabel: `${OP[op]}する`,
      body: (
        <>
          <p>
            実行中の <b>{running.length} サービス</b>({running.map((s) => nameOf(v, s)).join(", ")}
            )を{OP[op]}します。
          </p>
          <ul className={IMPACT}>
            <li>
              {op === "stop"
                ? "停止後はこのアプリにアクセスできなくなります。"
                : "再起動が完了するまで(数秒〜)アクセスできなくなります。"}
            </li>
            <li>依存関係の逆順に{op === "stop" ? "停止" : "処理"}します。</li>
          </ul>
        </>
      ),
      onConfirm: () => void run(v, op),
    });
  };

  const onSvcOp = (v: AppView, svc: ServiceDef, op: Action) => {
    if (op === "start") return void run(v, op, svc);
    const st = v.statuses.find((x) => x.service_id === svc.id);
    const dependents = v.def.services.filter(
      (s) =>
        s.depends_on.includes(svc.id) &&
        v.statuses.find((x) => x.service_id === s.id)?.state === "running",
    );
    setConfirm({
      title: `${nameOf(v, svc)} を${OP[op]}しますか?`,
      destructive: true,
      confirmLabel: `${OP[op]}する`,
      body: (
        <>
          <p>
            {v.def.name} のサービス <b>{nameOf(v, svc)}</b>
            {st?.pid ? `(PID ${st.pid})` : ""}を{OP[op]}します。
          </p>
          <ul className={IMPACT}>
            {dependents.length ? (
              <li className="text-amber-300">
                依存しているサービス <b>{dependents.map((d) => nameOf(v, d)).join(", ")}</b>{" "}
                が正常に動作しなくなる可能性があります。
              </li>
            ) : (
              <li>このサービスに依存している実行中のサービスはありません。</li>
            )}
          </ul>
        </>
      ),
      onConfirm: () => void run(v, op, svc),
    });
  };

  const onMode = async (v: AppView, mode: string) => {
    const id = v.def.id;
    setModeBusy((b) => ({ ...b, [id]: true }));
    try {
      await apiFetch(`/api/apps/${encodeURIComponent(id)}/mode`, { method: "PUT", body: { mode } });
      setMsg(id, {
        type: "info",
        text: `起動モードを ${mode} に切り替えました。次回の起動から適用されます`,
        at: new Date(),
      });
      toast("ok", v.def.name, `起動モードを ${mode} に切り替えました`);
    } catch (e) {
      const text = errorMessage(e);
      setMsg(id, {
        type: "error",
        text: `起動モードの切替に失敗しました — ${text}`,
        at: new Date(),
      });
      toast("error", `${v.def.name} の起動モード切替に失敗`, text);
    } finally {
      setModeBusy((b) => omit(b, id));
      await doRefresh(false);
    }
  };

  const bulkTargets = (op: Action) => (apps ?? []).filter((v) => isBulkTarget(states(v), op));
  const bulkCan = (op: Action) => !anyBusy && bulkTargets(op).length > 0;

  const runBulk = async (op: Action, mode: "continue" | "abort") => {
    setBulkBusy(op);
    try {
      const r = await apiFetch<BulkResult>(`/api/bulk/${op}`, {
        method: "POST",
        query: { on_failure: mode },
      });
      const nameMap = new Map((appsRef.current ?? []).map((v) => [v.def.id, v.def.name]));
      const view: BulkView = {
        op,
        onFail: mode,
        overall: r.status,
        at: new Date(),
        apps: r.apps.map((a) => {
          const c = countResults(a.results);
          return {
            appId: a.app_id,
            name: nameMap.get(a.app_id) ?? a.app_id,
            result: a.status,
            summary:
              a.message ??
              (c.error
                ? `${c.error} 件失敗 / ${c.ok} 件成功`
                : c.ok
                  ? `${c.ok} サービスを${OP[op]}`
                  : "対象サービスなし"),
            services: a.results.map((s) => ({
              service: s.service_id,
              result: s.result,
              message: s.message ?? (s.result === "ok" ? `${OP[op]}しました` : ""),
            })),
          };
        }),
      };
      setBulkResult(view);
      setSheetOpen(true);
      const oks = view.apps.filter((a) => a.result === "ok").length;
      const errs = view.apps.filter((a) => a.result === "error").length;
      toast(
        r.status === "ok" ? "ok" : "error",
        `一括${OP[op]}: ${OVERALL_LABEL[r.status]} (${r.status})`,
        `${oks} アプリ成功 / ${errs} アプリ失敗`,
      );
    } catch (e) {
      toast("error", `一括${OP[op]}に失敗`, errorMessage(e));
    } finally {
      setBulkBusy(null);
      await doRefresh(false);
    }
  };

  const onBulk = (op: Action) => {
    const targets = bulkTargets(op);
    const others = (apps?.length ?? 0) - targets.length;
    setConfirm({
      title: `全アプリを一括${OP[op]}しますか?`,
      destructive: op !== "start",
      confirmLabel: `一括${OP[op]}する`,
      body: (
        <>
          <p>
            対象 <b>{targets.length} アプリ</b>のサービスを順番に{OP[op]}します。
          </p>
          <ul className="list-disc ps-5 text-xs">
            {targets.map((v) => (
              <li key={v.def.id}>{v.def.name}</li>
            ))}
          </ul>
          <ul className={IMPACT}>
            {others > 0 && <li>対象外の {others} アプリはスキップされます。</li>}
            {op !== "start" && (
              <li className="text-amber-300">
                {op === "stop"
                  ? "停止したアプリにはアクセスできなくなります。"
                  : "処理中は各アプリに一時的にアクセスできなくなります。"}
              </li>
            )}
            <li>
              失敗時の挙動:{" "}
              <b>
                {onFail === "continue"
                  ? "続行 — 失敗しても残りを処理"
                  : "中断 — 最初の失敗で残りをスキップ"}
              </b>
            </li>
          </ul>
        </>
      ),
      onConfirm: () => void runBulk(op, onFail),
    });
  };

  const reloadConfig = async () => {
    setReloading(true);
    try {
      await apiFetch("/api/config/reload", { method: "POST" });
      const views = await load();
      setApps(views);
      setLastUpdated(new Date());
      const n = views.reduce((s, v) => s + v.def.services.length, 0);
      toast("ok", "設定を再読込しました", `${views.length} アプリ / ${n} サービス`);
    } catch (e) {
      toast("error", "設定の再読込に失敗しました", errorMessage(e));
    } finally {
      setReloading(false);
    }
  };

  const statusOf = (v: AppView): AppStatus =>
    appStatus(
      states(v),
      !!appBusy[v.def.id] || v.statuses.some((s) => s.busy),
      msgs[v.def.id]?.type === "error",
    );
  const counts = (apps ?? []).reduce<Partial<Record<AppStatus, number>>>((m, v) => {
    const s = statusOf(v);
    m[s] = (m[s] ?? 0) + 1;
    return m;
  }, {});

  // 共通シェル（サイドバー・モバイルヘッダー）へ更新状態を公開する
  const { setStatus } = useShellStatus();
  const errorCount = counts.error ?? 0;
  useEffect(() => {
    setStatus({
      lastUpdated,
      refreshing,
      paused,
      pollErr,
      cycle,
      active: screen === "normal",
      errorCount,
      connError: screen === "error",
      onRefresh: () => void refreshRef.current(true),
      onTogglePause: () => setPaused((p) => !p),
    });
  }, [setStatus, lastUpdated, refreshing, paused, pollErr, cycle, screen, errorCount]);
  useEffect(() => () => setStatus(null), [setStatus]);

  const reloadButton = (
    <Button
      type="button"
      className={BTN}
      onClick={() => void reloadConfig()}
      disabled={reloading || anyBusy || screen === "error" || screen === "loading"}
      title={anyBusy ? "操作中は再読込できません" : "POST /api/config/reload"}
    >
      {reloading ? <Spinner /> : <FileText size={14} aria-hidden="true" />}
      <span className="ms-1.5">設定を再読込</span>
    </Button>
  );

  const head = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-primary-foreground text-2xl font-bold tracking-widest">APPS</h1>
        {screen === "normal" && apps && (
          <p className="text-foreground/80 mt-1">
            {apps.length} アプリ ・ 実行中 {counts.running ?? 0} ・ 一部起動 {counts.partial ?? 0}{" "}
            ・ 停止中 {counts.stopped ?? 0}
            {counts.error ? <span className="text-rose-300"> ・ エラー {counts.error}</span> : null}
          </p>
        )}
      </div>
      {reloadButton}
    </div>
  );

  let body: React.ReactNode;
  if (screen === "loading") {
    body = <LoadingState message="アプリ一覧を読み込み中です" />;
  } else if (screen === "empty") {
    body = (
      <EmptyState
        title="アプリが登録されていません"
        description="config/apps.yaml に管理したいアプリとサービスを定義し、設定を再読込してください。"
      >
        <pre className="border-primary/30 bg-background/70 max-w-full overflow-x-auto border p-3 text-left text-xs">
          <code>{`apps:
  - id: my-app
    name: my-app
    description: ローカル開発用 Web アプリ
    workdir: ~/repo/my-app
    services:
      - id: web
        kind: process
        start: [npm, run, start]`}</code>
        </pre>
        <Button type="button" onClick={() => void reloadConfig()} disabled={reloading}>
          {reloading ? <Spinner /> : <FileText size={14} aria-hidden="true" />}
          <span className="ms-1.5">設定を再読込</span>
        </Button>
      </EmptyState>
    );
  } else if (screen === "error") {
    body = (
      <ErrorState
        title="バックエンドに接続できません"
        description="thoth のバックエンドに接続できませんでした。バックエンドが起動しているか確認してください。"
        retryLabel={refreshing ? "接続を再試行中…" : "再試行"}
        onRetry={() => {
          if (refreshing) return;
          setLoadError(false);
          void doRefresh(false);
        }}
      >
        <pre className="border-destructive/40 bg-background/70 max-w-full overflow-x-auto border p-3 text-left text-xs">
          <code>$ uv run python -m thoth.main</code>
        </pre>
      </ErrorState>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        {pollErr > 0 && (
          <div
            role="alert"
            className="border-destructive/60 bg-destructive/10 flex flex-wrap items-center gap-3 border p-4"
          >
            <TriangleAlert size={20} className="text-rose-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <strong>状態の更新に失敗しました(連続 {pollErr} 回)</strong>
              <p className="text-foreground/70 text-xs">
                表示中の状態は {fmtTime(lastUpdated)}{" "}
                時点のものです。バックエンドを確認してください。
              </p>
            </div>
            <Button
              type="button"
              className={BTN}
              onClick={() => void doRefresh(true)}
              disabled={refreshing}
            >
              {refreshing ? <Spinner /> : <RefreshCw size={14} aria-hidden="true" />}
              <span className="ms-1.5">再試行</span>
            </Button>
          </div>
        )}

        <section className={CARD} aria-labelledby="bulk-t">
          <div className="mb-4 flex items-baseline gap-3">
            <h2 id="bulk-t" className="text-lg font-bold">
              一括操作
            </h2>
            <span className="text-foreground/60 text-xs">全 {apps?.length} アプリ対象</span>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex flex-col gap-2">
              <RadioGroupRoot
                value={onFail}
                onValueChange={({ value }) => setOnFail(value === "abort" ? "abort" : "continue")}
                disabled={!!bulkBusy}
                orientation="horizontal"
                className="flex-row flex-wrap items-center gap-x-5 gap-y-2"
              >
                <RadioGroupLabel className="text-xs">失敗時の挙動</RadioGroupLabel>
                {(
                  [
                    ["continue", "続行"],
                    ["abort", "中断"],
                  ] as const
                ).map(([v, l]) => (
                  <RadioGroupItem key={v} value={v}>
                    <RadioGroupItemControl />
                    <RadioGroupItemText>
                      {l} <small className="text-foreground/60">{v}</small>
                    </RadioGroupItemText>
                  </RadioGroupItem>
                ))}
              </RadioGroupRoot>
              <Help>
                {onFail === "continue"
                  ? "失敗したアプリがあっても、残りのアプリの処理を続けます。"
                  : "最初に失敗した時点で中断し、残りのアプリはスキップします。"}
              </Help>
            </div>
            <div className="flex flex-wrap gap-3" role="group" aria-label="一括操作">
              {OPS.map((op) => {
                const Icon = OpIcon[op];
                return (
                  <Button
                    key={op}
                    type="button"
                    variant={OP_VARIANT[op]}
                    className={BTN}
                    disabled={!bulkCan(op)}
                    onClick={() => onBulk(op)}
                    title={
                      bulkCan(op)
                        ? undefined
                        : anyBusy
                          ? "操作中のアプリがあります"
                          : "対象となるアプリがありません"
                    }
                  >
                    {bulkBusy === op ? <Spinner /> : <Icon size={14} aria-hidden="true" />}
                    <span className="ms-1.5">一括{OP[op]}</span>
                  </Button>
                );
              })}
            </div>
          </div>
          {bulkBusy && (
            <div role="status" className="text-primary mt-4 flex items-center gap-2 text-xs">
              <Spinner />
              <span>一括{OP[bulkBusy]}を実行中…</span>
            </div>
          )}
          {bulkResult && !bulkBusy && (
            <button
              type="button"
              className="border-primary/30 hover:bg-primary/10 mt-4 flex w-full cursor-pointer items-center gap-3 border p-3 text-left text-xs"
              onClick={() => setSheetOpen(true)}
            >
              <ResultBadge
                r={
                  bulkResult.overall === "ok"
                    ? "ok"
                    : bulkResult.overall === "partial"
                      ? "skipped"
                      : "error"
                }
              />
              <span className="flex-1">
                前回の一括{OP[bulkResult.op]}の結果を表示({fmtTime(bulkResult.at)}・
                {bulkResult.overall})
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          )}
        </section>

        <div className="flex flex-col gap-6">
          {(apps ?? []).map((v) => (
            <AppCard
              key={v.def.id}
              v={v}
              st={statusOf(v)}
              busyOp={appBusy[v.def.id]}
              svcBusy={svcBusy}
              locked={!!bulkBusy || !!modeBusy[v.def.id]}
              msg={msgs[v.def.id] ?? null}
              onAppOp={onAppOp}
              onSvcOp={onSvcOp}
              onMode={onMode}
              onDismiss={() => setMsg(v.def.id, null)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {head}
      {body}
      <Toaster toaster={toaster}>
        {(t) => (
          <ToastRoot
            className={
              t.type === "error"
                ? "w-80 max-w-[calc(100vw-3rem)] [--color-frame-1-stroke:var(--color-destructive)] [--color-frame-1-fill:var(--color-destructive)]/20"
                : "w-80 max-w-[calc(100vw-3rem)]"
            }
          >
            <ToastTitle className="text-wrap pe-8">{t.title}</ToastTitle>
            {t.description && (
              <ToastDescription className="text-wrap">{t.description}</ToastDescription>
            )}
            <ToastCloseTrigger />
          </ToastRoot>
        )}
      </Toaster>
      <ConfirmDialog cfg={confirm} onClose={() => setConfirm(null)} />
      <ResultSheet open={sheetOpen} result={bulkResult} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

const MSG_TONE: Record<Msg["type"], string> = {
  ok: "border-success/60 bg-success/10",
  error: "border-destructive/60 bg-destructive/10",
  info: "border-primary/60 bg-primary/10",
};

function AppCard({
  v,
  st,
  busyOp,
  svcBusy,
  locked,
  msg,
  onAppOp,
  onSvcOp,
  onMode,
  onDismiss,
}: {
  v: AppView;
  st: AppStatus;
  busyOp?: Action;
  svcBusy: Record<string, Action>;
  locked: boolean;
  msg: Msg | null;
  onAppOp: (v: AppView, op: Action) => void;
  onSvcOp: (v: AppView, s: ServiceDef, op: Action) => void;
  onMode: (v: AppView, m: string) => void;
  onDismiss: () => void;
}) {
  const { def, statuses } = v;
  const stateOf = (id: string): ServiceStatus | undefined =>
    statuses.find((s) => s.service_id === id);
  const sup = statuses.filter((s) => s.state !== "unsupported");
  const running = sup.filter((s) => s.state === "running");
  const stopped = sup.filter((s) => s.state === "stopped");
  const remoteBusy = statuses.some((s) => s.busy);
  const lock = locked || !!busyOp || remoteBusy;
  const why = (op: Action) =>
    busyOp || remoteBusy
      ? "操作中です"
      : locked
        ? "一括操作の実行中です"
        : op === "start"
          ? "起動できるサービスがありません(全て実行中)"
          : "実行中のサービスがありません";
  const can = {
    start: !lock && stopped.length > 0,
    stop: !lock && running.length > 0,
    restart: !lock && running.length > 0,
  };
  const lockReason = busyOp
    ? "操作中は切り替えできません"
    : locked
      ? "一括操作の実行中は切り替えできません"
      : running.length > 0
        ? "起動中のサービスがあるため切替不可 — 停止してから切り替えてください"
        : null;
  const ordered = topo(def.services);

  return (
    <article
      className={`${CARD} border-l-4 ${CARD_EDGE[st]}`}
      data-status={st}
      aria-labelledby={`t-${def.id}`}
      aria-busy={!!busyOp}
    >
      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id={`t-${def.id}`} className="text-lg font-bold">
            {def.name}
          </h3>
          <AppBadge status={st} op={busyOp} />
        </div>
        {def.description && <p className="text-foreground/70 mt-1">{def.description}</p>}
        <div className="text-foreground/60 mt-2 flex gap-4 text-xs">
          <span>
            実行中{" "}
            <b className="text-foreground">
              {running.length}/{sup.length}
            </b>
          </span>
          <span>{def.services.length} サービス</span>
        </div>
      </header>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <ModeSelector view={v} lockReason={lockReason} onChange={(m) => onMode(v, m)} />
        <div className="flex flex-wrap gap-3" role="group" aria-label={`${def.name} の操作`}>
          {OPS.map((op) => (
            <OpButton
              key={op}
              op={op}
              disabled={!can[op]}
              busy={busyOp === op}
              reason={can[op] ? null : why(op)}
              onClick={() => onAppOp(v, op)}
              label={`${def.name} を${OP[op]}`}
            />
          ))}
        </div>
      </div>
      {msg && (
        <div
          className={`mt-4 flex items-start gap-2 border p-3 text-xs ${MSG_TONE[msg.type]}`}
          role={msg.type === "error" ? "alert" : "status"}
        >
          {msg.type === "error" ? (
            <TriangleAlert size={16} aria-hidden="true" />
          ) : msg.type === "ok" ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Info size={16} aria-hidden="true" />
          )}
          <p className="min-w-0 flex-1 break-words">
            <span>{msg.text}</span> <time className="text-foreground/60">{fmtTime(msg.at)}</time>
          </p>
          <button
            type="button"
            className="cursor-pointer underline"
            aria-label="メッセージを閉じる"
            onClick={onDismiss}
          >
            閉じる
          </button>
        </div>
      )}
      <ul className="mt-4 flex flex-col gap-2" aria-label={`${def.name} のサービス`}>
        {ordered.map((s) => {
          const ss = stateOf(s.id);
          const state: ServiceState = ss?.state ?? "unsupported";
          const unsup = state === "unsupported";
          const busy = svcBusy[`${def.id}/${s.id}`];
          const sCan = {
            start: !lock && state === "stopped",
            stop: !lock && state === "running",
            restart: !lock && state === "running",
          };
          const reason = (op: Action) =>
            unsup
              ? `未対応: kind ${s.kind} は thoth から操作できません`
              : lock
                ? "操作中のため実行できません"
                : op === "start"
                  ? "既に実行中です"
                  : "サービスが停止中です";
          return (
            <li
              key={s.id}
              className={`border-primary/20 flex flex-wrap items-center gap-x-6 gap-y-2 border p-3 ${unsup ? "opacity-70" : ""}`}
            >
              <div className="min-w-40 flex-1">
                <span className="font-bold">{s.name || s.id}</span>{" "}
                <span className="text-foreground/60 text-xs">{s.kind}</span>
              </div>
              <SvcBadge state={state} busy={busy ?? (ss?.busy as Action | undefined)} />
              <div className="text-foreground/70 flex flex-wrap gap-x-4 text-xs">
                <span>
                  PID <span className="text-foreground">{ss?.pid ?? "—"}</span>
                </span>
                <span>
                  依存{" "}
                  {s.depends_on.length ? (
                    s.depends_on.map((d) => (
                      <span className="text-foreground me-1" key={d}>
                        → {d}
                      </span>
                    ))
                  ) : (
                    <span>なし</span>
                  )}
                </span>
              </div>
              {unsup && (
                <p className="text-foreground/70 flex w-full items-center gap-1.5 text-xs">
                  <Ban size={14} aria-hidden="true" />
                  <span>操作できません: kind {s.kind} は thoth から操作できません</span>
                </p>
              )}
              <div className="flex gap-2" role="group" aria-label={`${s.name || s.id} の操作`}>
                {OPS.map((op) => (
                  <OpButton
                    key={op}
                    op={op}
                    disabled={!sCan[op]}
                    busy={busy === op}
                    reason={sCan[op] ? null : reason(op)}
                    onClick={() => onSvcOp(v, s, op)}
                    label={`${def.name} / ${s.name || s.id} を${OP[op]}`}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
