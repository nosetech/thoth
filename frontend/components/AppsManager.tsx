"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmCfg } from "@/components/apps/ConfirmDialog";
import {
  IcAlert,
  IcApps,
  IcBan,
  IcCheck,
  IcChevron,
  IcFile,
  IcHalf,
  IcInfo,
  IcLock,
  IcPause,
  IcPlay,
  IcPlug,
  IcRefresh,
  IcRestart,
  IcStop,
  IcX,
  Spinner,
} from "@/components/apps/icons";
import {
  fmtTime,
  OVERALL_LABEL,
  ResultBadge,
  ResultSheet,
  type BulkView,
} from "@/components/apps/ResultSheet";
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

const OpIcon = { start: IcPlay, stop: IcStop, restart: IcRestart };

type AppView = { def: AppDef; statuses: ServiceStatus[]; mode: ModeInfo | null };
type Msg = { type: "ok" | "error" | "info"; text: string; at: Date };
type Toast = { id: string; type: "ok" | "error" | "info"; title: string; text?: string };

const APP_ST: Record<AppStatus, { label: string; cls: string; Icon: typeof IcCheck | null }> = {
  running: { label: "実行中", cls: "ok", Icon: IcCheck },
  stopped: { label: "停止中", cls: "muted", Icon: IcStop },
  partial: { label: "一部起動", cls: "warn", Icon: IcHalf },
  busy: { label: "操作中", cls: "primary", Icon: null },
  error: { label: "エラー", cls: "danger", Icon: IcAlert },
};

function AppBadge({ status, op }: { status: AppStatus; op?: Action }) {
  const m = APP_ST[status];
  return (
    <span className={`badge b-${m.cls}`}>
      {m.Icon ? <m.Icon size={13} /> : <Spinner size={13} />}
      <span>
        {m.label}
        {status === "busy" && op ? `・${OP[op]}` : ""}
      </span>
    </span>
  );
}

function SvcBadge({ state, busy }: { state: ServiceState; busy?: Action }) {
  if (busy)
    return (
      <span className="badge b-primary">
        <Spinner size={12} />
        <span>{OP[busy]}中…</span>
      </span>
    );
  const m = {
    running: { cls: "ok", Icon: IcCheck, ja: "実行中" },
    stopped: { cls: "muted", Icon: IcStop, ja: "停止" },
    unsupported: { cls: "unsup", Icon: IcBan, ja: "未対応" },
  }[state];
  return (
    <span className={`badge b-${m.cls}`}>
      <m.Icon size={12} />
      <span className="mono">{state}</span>
      <span className="sr-only">({m.ja})</span>
    </span>
  );
}

function OpButton({
  op,
  disabled,
  busy,
  onClick,
  label,
  reason,
  emphasis,
}: {
  op: Action;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  label: string;
  reason: string | null;
  emphasis?: boolean;
}) {
  const Icon = OpIcon[op];
  return (
    <button
      type="button"
      className={`btn op op-${op} ${emphasis ? "op-strong" : ""}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={disabled && reason ? reason : label}
    >
      {busy ? <Spinner size={15} /> : <Icon size={15} />}
      <span>{OP[op]}</span>
    </button>
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
  const id = `mode-${def.id}`;
  const current = mode?.mode ?? "local";
  const unavailable = (m: string): string | null => {
    if (!def.modes.includes(m)) return "このアプリでは未定義です";
    const o = mode?.modes.find((x) => x.name === m);
    return o && !o.available ? (o.reason ?? "利用できません") : null;
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const btns = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    btns[(i + d + btns.length) % btns.length].focus();
  };
  return (
    <div className="mode">
      <div className="mode-label" id={`${id}-l`}>
        起動モード
      </div>
      <div
        className="seg"
        role="radiogroup"
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-h`}
        onKeyDown={onKey}
      >
        {MODES.map((m) => {
          const un = unavailable(m);
          const selected = current === m;
          const reason = selected ? null : (un ?? lockReason);
          return (
            <span className="tip" key={m}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={reason ? true : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  if (!reason && !selected) onChange(m);
                }}
                aria-label={reason ? `${m}(選択不可: ${reason})` : m}
              >
                {un && <IcLock size={12} />}
                <span className="mono">{m}</span>
              </button>
              {reason && (
                <span className="tip-body" role="tooltip">
                  {reason}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <div className="mode-help" id={`${id}-h`}>
        {lockReason && (
          <p className="help help-warn">
            <IcLock size={13} />
            {lockReason}
          </p>
        )}
        {MODES.filter((m) => unavailable(m)).map((m) => (
          <p className="help" key={m}>
            <IcBan size={13} />
            <span>
              <code>{m}</code> は選択不可: {unavailable(m)}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

export function AppsManager() {
  const [apps, setApps] = useState<AppView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [appBusy, setAppBusy] = useState<Record<string, Action>>({});
  const [svcBusy, setSvcBusy] = useState<Record<string, Action>>({});
  const [msgs, setMsgs] = useState<Record<string, Msg | null>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
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
  const appsRef = useRef<AppView[] | null>(null);
  useEffect(() => {
    appsRef.current = apps;
  }, [apps]);

  const toast = useCallback((type: Toast["type"], title: string, text?: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, type, title, text }].slice(-4));
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      type === "error" ? 8000 : 5000,
    );
  }, []);

  const load = useCallback(async (): Promise<AppView[]> => {
    const defs = await apiFetch<AppDef[]>("/api/apps");
    return Promise.all(
      defs.map(async (def): Promise<AppView> => {
        const [statuses, mode] = await Promise.all([
          apiFetch<ServiceStatus[]>(`/api/apps/${def.id}/status`),
          apiFetch<ModeInfo>(`/api/apps/${def.id}/mode`).catch(() => null),
        ]);
        return { def, statuses, mode };
      }),
    );
  }, []);

  const doRefresh = useCallback(
    async (manual: boolean) => {
      if (refreshing$.current) return;
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
        if (mounted.current) {
          setRefreshing(false);
          setCycle((c) => c + 1);
        }
      }
    },
    [load, toast],
  );

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
        await apiFetch(`/api/apps/${id}/services/${svc.id}/${op}`, { method: "POST" });
        const text = `${nameOf(v, svc)} を${OP[op]}しました`;
        setMsg(id, { type: "ok", text, at: new Date() });
        toast("ok", label, text);
      } else {
        const r = await apiFetch<{ results: ServiceResult[] }>(`/api/apps/${id}/${op}`, {
          method: "POST",
        });
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
            実行中の <b>{running.length} サービス</b>(
            <span className="mono">{running.map((s) => nameOf(v, s)).join(", ")}</span>)を
            {OP[op]}します。
          </p>
          <ul className="impact">
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
            <span className="mono">{v.def.name}</span> のサービス{" "}
            <b className="mono">{nameOf(v, svc)}</b>
            {st?.pid ? `(PID ${st.pid})` : ""}を{OP[op]}します。
          </p>
          <ul className="impact">
            {dependents.length ? (
              <li className="impact-warn">
                依存しているサービス{" "}
                <b className="mono">{dependents.map((d) => nameOf(v, d)).join(", ")}</b>{" "}
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
    setAppBusy((b) => ({ ...b, [id]: "restart" }));
    try {
      await apiFetch(`/api/apps/${id}/mode`, { method: "PUT", body: { mode } });
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
      setAppBusy((b) => omit(b, id));
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
          <ul className="target-list">
            {targets.map((v) => (
              <li key={v.def.id} className="mono">
                {v.def.name}
              </li>
            ))}
          </ul>
          <ul className="impact">
            {others > 0 && <li>対象外の {others} アプリはスキップされます。</li>}
            {op !== "start" && (
              <li className="impact-warn">
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

  const retrying = refreshing && screen === "error";

  const head = (
    <div className="page-head">
      <div>
        <h1>APPS</h1>
        {screen === "normal" && apps && (
          <p className="sub">
            {apps.length} アプリ ・ 実行中 {counts.running ?? 0} ・ 一部起動 {counts.partial ?? 0}{" "}
            ・ 停止中 {counts.stopped ?? 0}
            {counts.error ? <span className="t-danger"> ・ エラー {counts.error}</span> : null}
          </p>
        )}
      </div>
      <button
        type="button"
        className="btn reload"
        onClick={() => void reloadConfig()}
        disabled={reloading || anyBusy || screen === "error" || screen === "loading"}
        title={anyBusy ? "操作中は再読込できません" : "POST /api/config/reload"}
      >
        {reloading ? <Spinner /> : <IcFile size={16} />}
        <span>設定を再読込</span>
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (screen === "loading") {
    body = (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">アプリ一覧を読み込み中です</span>
        {[0, 1, 2].map((i) => (
          <div className="card app sk-card" key={i} aria-hidden="true">
            <div className="sk" style={{ width: "40%", height: 22 }} />
            <div className="sk" style={{ width: "75%", height: 14, marginTop: 12 }} />
            <div className="sk-row">
              <div className="sk" style={{ width: 170, height: 44 }} />
              <div className="sk" style={{ width: 240, height: 44 }} />
            </div>
            {[0, 1].map((j) => (
              <div className="sk" key={j} style={{ width: "100%", height: 48, marginTop: 10 }} />
            ))}
          </div>
        ))}
      </div>
    );
  } else if (screen === "empty") {
    body = (
      <div className="card state">
        <div className="state-ic">
          <IcApps size={30} />
        </div>
        <h2>アプリが登録されていません</h2>
        <p>
          <code>config/apps.yaml</code>{" "}
          に管理したいアプリとサービスを定義し、設定を再読込してください。
        </p>
        <pre className="code" aria-label="apps.yaml の記述例">
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
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void reloadConfig()}
          disabled={reloading}
        >
          {reloading ? <Spinner /> : <IcFile size={16} />}
          <span>設定を再読込</span>
        </button>
      </div>
    );
  } else if (screen === "error") {
    body = (
      <div className="card state state-error" role="alert">
        <div className="state-ic">
          <IcPlug size={30} />
        </div>
        <h2>バックエンドに接続できません</h2>
        <p>
          thoth のバックエンドに接続できませんでした。バックエンドが起動しているか確認してください。
        </p>
        <pre className="code">
          <code>$ uv run python -m thoth.main</code>
        </pre>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setLoadError(false);
            void doRefresh(false);
          }}
          disabled={retrying}
        >
          {retrying ? <Spinner /> : <IcRefresh size={16} />}
          <span>{retrying ? "接続を再試行中…" : "再試行"}</span>
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {pollErr > 0 && (
          <div className="banner" role="alert">
            <IcAlert size={20} />
            <div>
              <strong>状態の更新に失敗しました(連続 {pollErr} 回)</strong>
              <p>
                表示中の状態は {fmtTime(lastUpdated)}{" "}
                時点のものです。バックエンドを確認してください。
              </p>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void doRefresh(true)}
              disabled={refreshing}
            >
              {refreshing ? <Spinner /> : <IcRefresh size={16} />}
              <span>再試行</span>
            </button>
          </div>
        )}

        <div className="refresh">
          <div className="refresh-info" title={`最終更新 ${fmtTime(lastUpdated)}`}>
            <span
              className={`live ${paused ? "is-paused" : pollErr ? "is-err" : ""}`}
              aria-hidden="true"
            />
            <div>
              <span>
                最終更新 <time className="mono">{fmtTime(lastUpdated)}</time>
              </span>
              <span className="dim small">
                {paused ? "自動更新は一時停止中" : "5 秒ごとに自動更新"}
              </span>
            </div>
          </div>
          <div className="refresh-btns">
            <button
              type="button"
              className="btn"
              onClick={() => void doRefresh(true)}
              disabled={refreshing}
              aria-label="今すぐ更新"
              title="今すぐ更新"
            >
              {refreshing ? <Spinner /> : <IcRefresh size={16} />}
              <span>更新</span>
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={paused}
              aria-label={paused ? "自動更新を再開" : "自動更新を一時停止"}
              title={paused ? "自動更新を再開" : "自動更新を一時停止"}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? <IcPlay size={14} /> : <IcPause size={16} />}
              <span>{paused ? "再開" : "一時停止"}</span>
            </button>
          </div>
          <div className="pollbar-track" aria-hidden="true">
            <div key={`${cycle}-${paused}`} className={`pollbar ${paused ? "is-paused" : ""}`} />
          </div>
        </div>

        <section className="card bulk" aria-labelledby="bulk-t">
          <div className="bulk-head">
            <h2 id="bulk-t" className="h2">
              一括操作
            </h2>
            <span className="dim small">全 {apps?.length} アプリ対象</span>
          </div>
          <div className="bulk-grid">
            <fieldset className="onfail">
              <legend>失敗時の挙動</legend>
              <div className="seg seg-radio">
                {(
                  [
                    ["continue", "続行"],
                    ["abort", "中断"],
                  ] as const
                ).map(([v, l]) => (
                  <label key={v} className="seg-opt">
                    <input
                      type="radio"
                      name="onfail"
                      value={v}
                      checked={onFail === v}
                      onChange={() => setOnFail(v)}
                      disabled={!!bulkBusy}
                    />
                    <span>
                      {l} <small className="mono">{v}</small>
                    </span>
                  </label>
                ))}
              </div>
              <p className="help">
                {onFail === "continue"
                  ? "失敗したアプリがあっても、残りのアプリの処理を続けます。"
                  : "最初に失敗した時点で中断し、残りのアプリはスキップします。"}
              </p>
            </fieldset>
            <div className="bulk-actions" role="group" aria-label="一括操作">
              {OPS.map((op) => {
                const Icon = OpIcon[op];
                return (
                  <button
                    key={op}
                    type="button"
                    className={`btn op op-${op} op-strong`}
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
                    {bulkBusy === op ? <Spinner size={15} /> : <Icon size={15} />}
                    <span>一括{OP[op]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {bulkBusy && (
            <div className="bulk-prog" role="status">
              <Spinner size={15} />
              <span>一括{OP[bulkBusy]}を実行中…</span>
            </div>
          )}
          {bulkResult && !bulkBusy && (
            <button
              type="button"
              className="btn btn-ghost last-result"
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
              <span>
                前回の一括{OP[bulkResult.op]}の結果を表示({fmtTime(bulkResult.at)}・
                {bulkResult.overall})
              </span>
              <IcChevron size={16} />
            </button>
          )}
        </section>

        <div className="app-list">
          {(apps ?? []).map((v) => (
            <AppCard
              key={v.def.id}
              v={v}
              st={statusOf(v)}
              busyOp={appBusy[v.def.id]}
              svcBusy={svcBusy}
              locked={!!bulkBusy}
              msg={msgs[v.def.id] ?? null}
              onAppOp={onAppOp}
              onSvcOp={onSvcOp}
              onMode={onMode}
              onDismiss={() => setMsg(v.def.id, null)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="ta">
      {head}
      {body}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast t-${t.type}`}
            role={t.type === "error" ? "alert" : "status"}
          >
            <span className="t-ic">
              {t.type === "error" ? (
                <IcAlert size={18} />
              ) : t.type === "ok" ? (
                <IcCheck size={18} />
              ) : (
                <IcInfo size={18} />
              )}
            </span>
            <div className="t-text">
              <strong>{t.title}</strong>
              {t.text && <p>{t.text}</p>}
            </div>
            <button
              type="button"
              className="btn btn-ghost icon"
              aria-label="通知を閉じる"
              onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}
            >
              <IcX size={15} />
            </button>
          </div>
        ))}
      </div>
      <ConfirmDialog cfg={confirm} onClose={() => setConfirm(null)} />
      <ResultSheet open={sheetOpen} result={bulkResult} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

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
      className="card app"
      data-status={st}
      aria-labelledby={`t-${def.id}`}
      aria-busy={!!busyOp}
    >
      <header className="app-head">
        <div className="app-title">
          <h3 id={`t-${def.id}`} className="mono">
            {def.name}
          </h3>
          <AppBadge status={st} op={busyOp} />
        </div>
        {def.description && <p className="desc">{def.description}</p>}
        <div className="meta">
          <span>
            実行中{" "}
            <b className="mono">
              {running.length}/{sup.length}
            </b>
          </span>
          <span>{def.services.length} サービス</span>
        </div>
      </header>
      <div className="app-controls">
        <ModeSelector view={v} lockReason={lockReason} onChange={(m) => onMode(v, m)} />
        <div className="app-actions" role="group" aria-label={`${def.name} の操作`}>
          {OPS.map((op) => (
            <OpButton
              key={op}
              op={op}
              emphasis
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
        <div className={`msg msg-${msg.type}`} role={msg.type === "error" ? "alert" : "status"}>
          {msg.type === "error" ? (
            <IcAlert size={16} />
          ) : msg.type === "ok" ? (
            <IcCheck size={16} />
          ) : (
            <IcInfo size={16} />
          )}
          <p>
            <span>{msg.text}</span>
            <time className="dim">{fmtTime(msg.at)}</time>
          </p>
          <button
            type="button"
            className="btn btn-ghost icon"
            aria-label="メッセージを閉じる"
            onClick={onDismiss}
          >
            <IcX size={15} />
          </button>
        </div>
      )}
      <div className="svc-wrap">
        <div className="svc-head" aria-hidden="true">
          <span>サービス</span>
          <span>状態</span>
          <span>PID</span>
          <span>依存</span>
          <span>操作</span>
        </div>
        <ul className="svc-list" aria-label={`${def.name} のサービス`}>
          {ordered.map((s) => {
            const ss = stateOf(s.id);
            const state: ServiceState = ss?.state ?? "unsupported";
            const unsup = state === "unsupported";
            const busy = svcBusy[`${def.id}/${s.id}`];
            const sLock = lock;
            const sCan = {
              start: !sLock && state === "stopped",
              stop: !sLock && state === "running",
              restart: !sLock && state === "running",
            };
            const reason = (op: Action) =>
              unsup
                ? `未対応: kind ${s.kind} は thoth から操作できません`
                : sLock
                  ? "操作中のため実行できません"
                  : op === "start"
                    ? "既に実行中です"
                    : "サービスが停止中です";
            return (
              <Fragment key={s.id}>
                <li className={`svc ${unsup ? "is-unsup" : ""}`}>
                  <div className="svc-name">
                    <span className="mono strong">{s.name || s.id}</span>
                    <span className="kind mono">{s.kind}</span>
                  </div>
                  <div className="svc-status">
                    <SvcBadge state={state} busy={busy ?? (ss?.busy as Action | undefined)} />
                  </div>
                  <div className="svc-meta">
                    <div className="svc-pid">
                      <span className="lbl">PID</span>
                      <span className="mono">{ss?.pid ?? "—"}</span>
                    </div>
                    <div className="svc-deps">
                      <span className="lbl">依存</span>
                      {s.depends_on.length ? (
                        s.depends_on.map((d) => (
                          <span className="chip mono" key={d}>
                            → {d}
                          </span>
                        ))
                      ) : (
                        <span className="dim">なし</span>
                      )}
                    </div>
                  </div>
                  {unsup && (
                    <p className="unsup-reason">
                      <IcBan size={14} />
                      <span>操作できません: kind {s.kind} は thoth から操作できません</span>
                    </p>
                  )}
                  <div className="svc-actions" role="group" aria-label={`${s.name || s.id} の操作`}>
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
              </Fragment>
            );
          })}
        </ul>
      </div>
    </article>
  );
}
