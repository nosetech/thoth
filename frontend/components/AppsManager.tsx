"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, EmptyState, LoadingState } from "@/components/states";
import { apiFetch } from "@/lib/api";
import {
  ACTION_LABEL,
  errorMessage,
  needsConfirm,
  summarize,
  summarizeResults,
  SUMMARY_LABEL,
  type Action,
  type AppDef,
  type BulkResult,
  type ModeInfo,
  type ServiceResult,
  type ServiceStatus,
} from "@/lib/apps";

const POLL_MS = 5000;
const MODE_LABEL: Record<string, string> = { local: "local", lan: "LAN", vpn: "VPN" };

type AppView = { def: AppDef; statuses: ServiceStatus[]; mode: ModeInfo | null };
type Notice = { kind: "ok" | "error"; text: string };
type Pending = {
  title: string;
  description: string;
  label: string;
  run: () => Promise<void>;
};

const btn =
  "min-h-11 min-w-16 cursor-pointer border px-3 py-1 text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40";
const btnTone = {
  start: "border-success/70 text-success hover:bg-success/15",
  stop: "border-destructive/70 text-destructive hover:bg-destructive/15",
  restart: "border-primary/70 text-primary hover:bg-primary/15",
} as const;

const STATE_STYLE = {
  running: "border-success/70 text-success",
  partial: "border-amber-400/70 text-amber-300",
  stopped: "border-foreground/30 text-foreground/70",
  unsupported: "border-foreground/30 text-foreground/50",
} as const;

function Badge({ kind, children }: { kind: keyof typeof STATE_STYLE; children: React.ReactNode }) {
  return (
    <span className={`inline-block border px-2 py-0.5 text-xs font-bold ${STATE_STYLE[kind]}`}>
      {children}
    </span>
  );
}

function resultText(results: ServiceResult[]): string {
  const c = summarizeResults(results);
  return `成功 ${c.ok} / スキップ ${c.skipped} / 失敗 ${c.error}`;
}

export function AppsManager() {
  const [apps, setApps] = useState<AppView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [staleError, setStaleError] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [onFailure, setOnFailure] = useState<"continue" | "abort">("continue");
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const defs = await apiFetch<AppDef[]>("/api/apps");
      const views = await Promise.all(
        defs.map(async (def): Promise<AppView> => {
          const [statuses, mode] = await Promise.all([
            apiFetch<ServiceStatus[]>(`/api/apps/${def.id}/status`),
            def.modes.length > 1
              ? apiFetch<ModeInfo>(`/api/apps/${def.id}/mode`).catch(() => null)
              : Promise.resolve(null),
          ]);
          return { def, statuses, mode };
        }),
      );
      if (!mounted.current) return;
      setApps(views);
      setLoadError(false);
      setStaleError(false);
    } catch {
      if (!mounted.current) return;
      setApps((cur) => {
        if (cur === null) setLoadError(true);
        else setStaleError(true);
        return cur;
      });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const tick = () => document.visibilityState === "visible" && void refresh();
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      mounted.current = false;
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, attempt]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((s) => new Set(s).add(key));
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
      await refresh();
    }
  };

  const ask = (p: Pending) => setPending(p);

  const serviceAction = (app: AppDef, svc: { id: string; name: string }, action: Action) => {
    const run = () =>
      withBusy(`${app.id}/${svc.id}`, async () => {
        await apiFetch(`/api/apps/${app.id}/services/${svc.id}/${action}`, { method: "POST" });
        setNotice({
          kind: "ok",
          text: `${app.name} / ${svc.name} を${ACTION_LABEL[action]}しました`,
        });
      });
    if (needsConfirm(action, "service")) {
      ask({
        title: `${svc.name} を${ACTION_LABEL[action]}しますか？`,
        description: `${app.name} のサービス「${svc.name}」を${ACTION_LABEL[action]}します。`,
        label: ACTION_LABEL[action],
        run,
      });
    } else void run();
  };

  const appAction = (app: AppDef, action: Action) => {
    const run = () =>
      withBusy(app.id, async () => {
        const r = await apiFetch<{ results: ServiceResult[] }>(`/api/apps/${app.id}/${action}`, {
          method: "POST",
        });
        setNotice({
          kind: "ok",
          text: `${app.name} を${ACTION_LABEL[action]}しました（${resultText(r.results)}）`,
        });
      });
    if (needsConfirm(action, "app")) {
      ask({
        title: `${app.name} を${ACTION_LABEL[action]}しますか？`,
        description: `${app.name} の全サービスを${ACTION_LABEL[action]}します。`,
        label: ACTION_LABEL[action],
        run,
      });
    } else void run();
  };

  const bulkAction = (action: Action) => {
    ask({
      title: `全アプリを${ACTION_LABEL[action]}しますか？`,
      description: `登録されている ${apps?.length ?? 0} 件すべてのアプリを${ACTION_LABEL[action]}します。\n失敗時: ${
        onFailure === "continue" ? "残りのアプリも続行" : "最初の失敗で中断"
      }`,
      label: `全て${ACTION_LABEL[action]}`,
      run: () =>
        withBusy("bulk", async () => {
          const r = await apiFetch<BulkResult>(`/api/bulk/${action}`, {
            method: "POST",
            query: { on_failure: onFailure },
          });
          const failed = r.apps.filter((a) => a.status === "error").map((a) => a.app_id);
          const skipped = r.apps.filter((a) => a.status === "skipped").length;
          const head = `一括${ACTION_LABEL[action]}: ${
            r.status === "ok" ? "完了" : r.status === "partial" ? "一部失敗" : "失敗"
          }`;
          setNotice({
            kind: r.status === "ok" ? "ok" : "error",
            text: `${head}（スキップ ${skipped} 件${failed.length ? ` / 失敗: ${failed.join(", ")}` : ""}）`,
          });
        }),
    });
  };

  const changeMode = (app: AppDef, mode: string) =>
    withBusy(app.id, async () => {
      await apiFetch(`/api/apps/${app.id}/mode`, { method: "PUT", body: { mode } });
      setNotice({
        kind: "ok",
        text: `${app.name} の起動モードを ${MODE_LABEL[mode] ?? mode} に変更しました（次回起動から反映）`,
      });
    });

  if (loadError)
    return (
      <ErrorState
        title="アプリ一覧を取得できません"
        description="backend が起動しているか確認してください。"
        onRetry={() => {
          setLoadError(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  if (apps === null) return <LoadingState message="アプリを読み込み中..." />;
  if (apps.length === 0)
    return (
      <EmptyState
        title="登録アプリがありません"
        description="config/apps.yaml にアプリを定義して、設定を再読み込みしてください。"
      />
    );

  const bulkBusy = busy.has("bulk");
  const anyBusy = busy.size > 0;

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="一括操作"
        className="border-primary/40 flex flex-wrap items-center gap-3 border p-4"
      >
        <h2 className="mr-auto font-bold">一括操作</h2>
        <label className="flex items-center gap-2 text-sm">
          失敗時
          <select
            value={onFailure}
            onChange={(e) => setOnFailure(e.target.value as "continue" | "abort")}
            disabled={anyBusy}
            className="bg-background border-primary/40 min-h-11 border px-2"
          >
            <option value="continue">続行</option>
            <option value="abort">中断</option>
          </select>
        </label>
        {(["start", "stop", "restart"] as const).map((a) => (
          <button
            key={a}
            type="button"
            disabled={anyBusy}
            onClick={() => bulkAction(a)}
            className={`${btn} ${btnTone[a]}`}
          >
            全て{ACTION_LABEL[a]}
          </button>
        ))}
        {bulkBusy && (
          <span role="status" className="text-primary text-sm">
            一括操作を実行中...
          </span>
        )}
      </section>

      <div aria-live="polite" className="min-h-0">
        {notice && (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={`border px-4 py-3 ${notice.kind === "error" ? "border-destructive/60 text-destructive" : "border-success/60 text-success"}`}
          >
            {notice.text}
          </p>
        )}
        {staleError && (
          <p role="alert" className="border-amber-400/60 mt-2 border px-4 py-3 text-amber-300">
            状態を更新できません。最後に取得した状態を表示しています。
          </p>
        )}
      </div>

      <ul className="grid gap-4 lg:grid-cols-2">
        {apps.map(({ def, statuses, mode }) => {
          const byId = new Map(statuses.map((s) => [s.service_id, s]));
          const sum = summarize(statuses.map((s) => s.state));
          const appBusy = busy.has(def.id) || bulkBusy || statuses.some((s) => s.busy);
          const operable = sum !== "unsupported";
          const anyRunning = statuses.some((s) => s.state === "running");
          const current = mode?.mode ?? def.modes[0];
          return (
            <li key={def.id} className="border-primary/40 flex flex-col gap-3 border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-lg font-bold">{def.name}</h2>
                <Badge kind={sum}>{SUMMARY_LABEL[sum]}</Badge>
              </div>
              {def.description && <p className="text-foreground/70">{def.description}</p>}
              {appBusy && (
                <p role="status" className="text-primary text-sm">
                  操作を実行中...
                </p>
              )}

              {def.modes.length > 1 && (
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  起動モード
                  <select
                    value={current}
                    disabled={appBusy || anyRunning}
                    onChange={(e) => void changeMode(def, e.target.value)}
                    className="bg-background border-primary/40 min-h-11 border px-2"
                    aria-describedby={anyRunning ? `${def.id}-mode-hint` : undefined}
                  >
                    {def.modes.map((m) => {
                      const opt = mode?.modes.find((o) => o.name === m);
                      const ok = opt?.available ?? true;
                      return (
                        <option key={m} value={m} disabled={!ok}>
                          {MODE_LABEL[m] ?? m}
                          {!ok ? "（利用不可）" : ""}
                        </option>
                      );
                    })}
                  </select>
                  {anyRunning && (
                    <span id={`${def.id}-mode-hint`} className="text-foreground/60 text-xs">
                      停止してから切り替えられます
                    </span>
                  )}
                </label>
              )}

              <ul className="flex flex-col gap-2">
                {def.services.map((svc) => {
                  const st = byId.get(svc.id);
                  const state = st?.state ?? "unsupported";
                  const svcBusy = appBusy || busy.has(`${def.id}/${svc.id}`);
                  return (
                    <li
                      key={svc.id}
                      className="border-foreground/15 flex flex-wrap items-center gap-2 border-t pt-2"
                    >
                      <div className="mr-auto min-w-0">
                        <p className="truncate font-bold">{svc.name}</p>
                        <p className="text-foreground/60 text-xs">
                          {svc.kind}
                          {st?.pid ? ` · PID ${st.pid}` : ""}
                        </p>
                      </div>
                      <Badge kind={state}>{SUMMARY_LABEL[state]}</Badge>
                      {state !== "unsupported" && (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={svcBusy || state === "running"}
                            onClick={() => serviceAction(def, svc, "start")}
                            className={`${btn} ${btnTone.start}`}
                            aria-label={`${svc.name} を起動`}
                          >
                            起動
                          </button>
                          <button
                            type="button"
                            disabled={svcBusy || state === "stopped"}
                            onClick={() => serviceAction(def, svc, "stop")}
                            className={`${btn} ${btnTone.stop}`}
                            aria-label={`${svc.name} を停止`}
                          >
                            停止
                          </button>
                          <button
                            type="button"
                            disabled={svcBusy}
                            onClick={() => serviceAction(def, svc, "restart")}
                            className={`${btn} ${btnTone.restart}`}
                            aria-label={`${svc.name} を再起動`}
                          >
                            再起動
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {operable && (
                <div className="border-foreground/15 flex flex-wrap gap-2 border-t pt-3">
                  {(["start", "stop", "restart"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      disabled={appBusy}
                      onClick={() => appAction(def, a)}
                      className={`${btn} ${btnTone[a]} flex-1`}
                    >
                      全て{ACTION_LABEL[a]}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          description={pending.description}
          confirmLabel={pending.label}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void p.run();
          }}
        />
      )}
    </div>
  );
}
