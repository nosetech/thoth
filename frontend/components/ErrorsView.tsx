"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  CircleX,
  Clock,
  FileText,
  Info,
  ScrollText,
  Search,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react";
import { ConfirmDialog, type ConfirmCfg } from "@/components/apps/ConfirmDialog";
import { Badge, Spinner, type Tone } from "@/components/apps/parts";
import { PageHeading } from "@/components/PageHeading";
import { SelectField } from "@/components/SelectField";
import { notifyErrorsChanged } from "@/components/shell/useUnackErrors";
import { usePolling } from "@/components/shell/usePolling";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  RadioGroupItem,
  RadioGroupItemControl,
  RadioGroupItemText,
  RadioGroupLabel,
  RadioGroupRoot,
} from "@/components/ui/radio-group";
import { SwitchControl, SwitchLabel, SwitchRoot } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import {
  EMPTY_FILTER,
  absTime,
  filterFromSearch,
  filterQuery,
  isFiltered,
  logsHref,
  relTime,
  unackByApp,
  type AppRules,
  type ErrorEvent,
  type ErrorFilter,
  type ErrorList,
  type Rules,
  type Severity,
} from "@/lib/errors";

const CARD = "border border-primary/30 bg-background/70 p-4";
const SMALL = "px-4 py-1.5 text-xs";
const ALL = "__all__";

const SEV: Record<Severity, { tone: Tone; Icon: typeof CircleX; ja: string }> = {
  error: { tone: "danger", Icon: CircleX, ja: "重大" },
  warn: { tone: "warn", Icon: TriangleAlert, ja: "警告" },
};

export function SevBadge({ s, children }: { s: Severity; children?: React.ReactNode }) {
  const m = SEV[s];
  return (
    <Badge tone={m.tone}>
      <m.Icon size={12} aria-hidden="true" />
      <span>{children ?? s}</span>
      {!children && <span className="sr-only">({m.ja})</span>}
    </Badge>
  );
}

function DetRow({
  e,
  now,
  busy,
  onAck,
}: {
  e: ErrorEvent;
  now: number;
  busy: boolean;
  onAck: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // 省略表示で収まらない行だけ「全文を表示」を出す（画面幅で変わるため実測する）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setLong(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, e.line]);
  const lid = `dl-${e.id}`;
  const where = `${e.app_name} / ${e.service_name}`;
  return (
    <li
      className={`flex flex-col gap-2 border-l-4 py-3 ps-3 ${
        e.severity === "error" ? "border-l-destructive" : "border-l-amber-400"
      } ${e.acknowledged_at ? "opacity-70" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <SevBadge s={e.severity} />
        <time dateTime={e.detected_at} title={absTime(e.detected_at)}>
          {relTime(e.detected_at, now)}
          <span className="text-foreground/60"> ・ {absTime(e.detected_at)}</span>
        </time>
        {e.acknowledged_at ? (
          <Badge tone="muted">
            <Check size={12} aria-hidden="true" />
            <span>確認済み {absTime(e.acknowledged_at)}</span>
          </Badge>
        ) : (
          <Badge tone="primary">
            <Info size={12} aria-hidden="true" />
            <span>未確認</span>
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-mono font-bold">{where}</span>
        <span className="text-foreground/80 text-xs">
          ルール: {e.rule_name} <code className="text-foreground/60">{e.rule_id}</code>
        </span>
        <span className="text-foreground/60 font-mono text-xs">{e.file_name}</span>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <code
          ref={ref}
          id={lid}
          className={`border-primary/20 bg-background/60 min-w-0 flex-1 border px-2 py-1 font-mono text-xs ${
            open ? "break-all whitespace-pre-wrap" : "truncate"
          }`}
        >
          {e.line}
        </code>
        {(long || open) && (
          <Button
            type="button"
            className={SMALL}
            aria-expanded={open}
            aria-controls={lid}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            <span className="ms-1.5">{open ? "折りたたむ" : "全文を表示"}</span>
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href={logsHref(e)}
          aria-label={`${where} の ${e.file_name} をログで確認`}
          className="focus-visible:outline-primary text-primary-foreground border-primary/50 hover:bg-primary/10 inline-flex items-center gap-1.5 border px-4 py-1.5 text-xs outline-none focus-visible:outline-2"
        >
          <ScrollText size={14} aria-hidden="true" />
          ログで確認
        </Link>
        {!e.acknowledged_at && (
          <Button
            type="button"
            variant="success"
            className={SMALL}
            disabled={busy}
            onClick={() => onAck([e.id])}
            aria-label={`${where} の検知(${absTime(e.detected_at)})を確認済みにする`}
          >
            <Check size={14} aria-hidden="true" />
            <span className="ms-1.5">確認済みにする</span>
          </Button>
        )}
      </div>
    </li>
  );
}

function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-foreground/60">{k}</dt>
          <dd className="min-w-0 break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const dim = (t: string) => <span className="text-foreground/50">{t}</span>;

function RuleCard({ a }: { a: AppRules }) {
  const parsers = a.services.filter((s) => s.has_log_paths);
  return (
    <section className={`${CARD} flex flex-col gap-3`} aria-labelledby={`rc-${a.app_id}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={`rc-${a.app_id}`} className="font-mono text-base font-bold">
          {a.app_name}
        </h3>
        {a.mode === "custom" && (
          <Badge tone="primary">
            <FileText size={12} aria-hidden="true" />
            <span>独自ルール {a.rules.length} 件</span>
          </Badge>
        )}
        {a.mode === "default" && (
          <Badge tone="muted">
            <Info size={12} aria-hidden="true" />
            <span>既定ルール(ERROR レベルを検知)</span>
          </Badge>
        )}
        {a.mode === "disabled" && (
          <Badge tone="unsup">
            <Ban size={12} aria-hidden="true" />
            <span>検知しない</span>
          </Badge>
        )}
      </header>
      {a.mode === "disabled" ? (
        <p className="text-foreground/70 flex items-center gap-1.5 text-xs">
          <Ban size={13} aria-hidden="true" />
          このアプリはエラー検知を無効にしています(<code>error_rules: []</code>
          )。有効にするには config/apps.yaml を編集してください。
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-foreground/60 text-xs">パーサ</span>
            {parsers.length === 0 ? (
              <p className="text-xs">{dim("log_paths を持つサービスがありません")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {parsers.map((s) => (
                  <li key={s.service_id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono">{s.service_name}:</span>
                    {s.parser.kind === "auto" ? (
                      <span>
                        既定の自動推定(ERROR / WARN / INFO / DEBUG などの一般的な表記を判定)
                      </span>
                    ) : (
                      <span className="min-w-0">
                        正規表現 <code>{s.parser.level_pattern}</code>
                        {s.parser.origin === "service" && dim("(サービスの設定)")}
                        {Object.keys(s.parser.level_map).length > 0 && (
                          <span className="font-mono">
                            {" "}
                            {Object.entries(s.parser.level_map)
                              .map(([k, v]) => `${k}→${v}`)
                              .join(" ")}
                          </span>
                        )}
                      </span>
                    )}
                    {!s.monitored && dim("(このサービスにはルールが適用されません)")}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {a.mode === "default" && (
            <p className="text-foreground/70 flex items-center gap-1.5 text-xs">
              <Info size={13} aria-hidden="true" />
              独自ルールが未設定のため、既定ルールが適用されています。
            </p>
          )}
          <ul className="flex flex-col gap-3">
            {a.rules.map((r) => (
              <li key={r.id} className="border-primary/20 flex flex-col gap-2 border-t pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SevBadge s={r.severity} />
                  <strong>{r.name}</strong>
                  <code className="text-foreground/60 text-xs">{r.id}</code>
                </div>
                <Facts
                  items={[
                    [
                      "レベル条件",
                      r.levels.length ? (
                        <span className="font-mono">{r.levels.join(" / ")}</span>
                      ) : (
                        dim("なし")
                      ),
                    ],
                    ["パターン", r.pattern ? <code>{r.pattern}</code> : dim("なし")],
                    ["除外パターン", r.exclude ? <code>{r.exclude}</code> : dim("なし")],
                    [
                      "対象サービス",
                      r.services.length ? (
                        <span className="font-mono">{r.services.join(", ")}</span>
                      ) : (
                        dim("すべて")
                      ),
                    ],
                  ]}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RulesPanel({ rules }: { rules: Rules }) {
  return (
    <div className="flex flex-col gap-4">
      <div role="note" className="border-primary/30 flex items-start gap-3 border p-3">
        <Info size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <strong>ルールは参照のみです</strong>
          <p className="text-foreground/70 text-xs">
            エラー検知ルールとパーサは <code>config/apps.yaml</code> の各アプリの{" "}
            <code>error_rules</code> / <code>log_format</code> で編集し、APPS
            画面の「設定を再読込」で反映します。
          </p>
        </div>
      </div>
      {rules.apps.map((a) => (
        <RuleCard key={a.app_id} a={a} />
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" role="status" className={`${CARD} flex flex-col gap-4`}>
      <span className="sr-only">検知結果を読み込み中です</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} aria-hidden="true" className="flex flex-col gap-2">
          <div className="bg-primary/10 h-3.5 w-2/5 animate-pulse" />
          <div className="bg-primary/10 h-3 w-3/4 animate-pulse" />
          <div className="bg-primary/10 h-7 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

type Tab = "detections" | "rules";

export function ErrorsView() {
  const [filter, setFilter] = useState<ErrorFilter>(EMPTY_FILTER);
  const [data, setData] = useState<ErrorList | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [rules, setRules] = useState<Rules | null>(null);
  const [rulesErr, setRulesErr] = useState(false);
  const [tab, setTab] = useState<Tab>("detections");
  const [cutoff, setCutoff] = useState<number | null>(null); // これ以下の id を一覧に表示する
  const [busy, setBusy] = useState(false);
  const [ackErr, setAckErr] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [live, setLive] = useState("");
  const [now, setNow] = useState(0);
  const epoch = useRef(0);
  const inFlight = useRef(false);

  const announce = useCallback((m: string) => {
    setLive("");
    setTimeout(() => setLive(m), 30);
  }, []);

  // URL（ダッシュボードの「ERRORS で確認」）の絞り込みを初期値にする
  useEffect(() => {
    const t = setTimeout(() => {
      const f = filterFromSearch(window.location.search);
      if (isFiltered(f)) setFilter(f);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const loadRules = useCallback(async () => {
    try {
      setRules(await apiFetch<Rules>("/api/errors/rules"));
      setRulesErr(false);
    } catch {
      setRulesErr(true);
    }
  }, []);

  const load = useCallback(
    async (reset: boolean) => {
      if (inFlight.current && !reset) return;
      inFlight.current = true;
      const my = reset ? ++epoch.current : epoch.current;
      try {
        const d = await apiFetch<ErrorList>("/api/errors", { query: filterQuery(filter) });
        if (my !== epoch.current) return;
        const maxId = d.events.reduce((m, e) => Math.max(m, e.id), 0);
        setCutoff((c) => (reset || c === null ? maxId : c));
        setData(d);
        setLoadErr(false);
        setNow(Date.now());
      } catch {
        if (my === epoch.current) setLoadErr(true);
      } finally {
        inFlight.current = false;
      }
    },
    [filter],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(true), 0);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    const t = setTimeout(() => void loadRules(), 0);
    return () => clearTimeout(t);
  }, [loadRules]);
  usePolling(data !== null, () => void load(false));

  const events = useMemo(() => data?.events ?? [], [data]);
  const shown = useMemo(
    () => (cutoff === null ? events : events.filter((e) => e.id <= cutoff)),
    [events, cutoff],
  );
  const pending = events.length - shown.length;

  // 一覧が空のときは新着をそのまま表示する。それ以外は「新しい検知 n 件を表示」に溜める
  const prevPending = useRef(0);
  useEffect(() => {
    if (pending > 0 && shown.length === 0) {
      const t = setTimeout(() => setCutoff(events.reduce((m, e) => Math.max(m, e.id), 0)), 0);
      return () => clearTimeout(t);
    }
    if (pending > prevPending.current) announce(`新しい検知が ${pending} 件あります`);
    prevPending.current = pending;
  }, [pending, shown.length, events, announce]);

  const shownUnack = shown.filter((e) => !e.acknowledged_at);
  const summary = data?.summary;
  const perApp = summary ? unackByApp(summary) : [];
  const filtered = isFiltered(filter);

  const ack = useCallback(
    async (ids: number[]) => {
      if (!ids.length) return;
      setBusy(true);
      setAckErr(false);
      try {
        const r = await apiFetch<{ acknowledged: number }>("/api/errors/ack", { body: { ids } });
        announce(
          ids.length === 1 ? "確認済みにしました" : `${r.acknowledged} 件を確認済みにしました`,
        );
        notifyErrorsChanged();
        await load(false);
      } catch {
        setAckErr(true);
      } finally {
        setBusy(false);
      }
    },
    [announce, load],
  );

  const ackAll = () => {
    const ids = shownUnack.map((e) => e.id);
    const by = new Map<string, number>();
    for (const e of shownUnack) {
      const k = `${e.app_name} / ${e.service_name}`;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    setConfirm({
      title: `表示中の未確認 ${ids.length} 件を確認済みにしますか?`,
      destructive: false,
      confirmLabel: "すべて確認済みにする",
      body: (
        <>
          <span className="block">
            現在のフィルタで表示されている未確認の検知 <b>{ids.length} 件</b>を確認済みにします。
          </span>
          <span className="block font-mono text-xs">
            {[...by].map(([k, n]) => (
              <span key={k} className="block">
                {k}({n})
              </span>
            ))}
          </span>
          <span className="text-foreground/70 block text-xs">
            確認済みの検知は既定で一覧に表示されなくなります(「確認済みも表示」で再表示できます)。ダッシュボードの要対応からも外れます。
          </span>
        </>
      ),
      onConfirm: () => {
        setConfirm(null);
        void ack(ids);
      },
    });
  };

  const setF = (patch: Partial<ErrorFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const clear = () => setFilter((f) => ({ ...EMPTY_FILTER, includeAck: f.includeAck }));

  const appRules = rules?.apps.find((a) => a.app_id === filter.app);
  const appItems = [
    { value: ALL, label: "すべて" },
    ...(rules?.apps ?? []).map((a) => ({ value: a.app_id, label: a.app_name })),
  ];
  const svcItems = [
    { value: ALL, label: "すべて" },
    ...(appRules?.services ?? []).map((s) => ({ value: s.service_id, label: s.service_name })),
  ];
  const ruleItems = [
    { value: ALL, label: "すべて" },
    ...(appRules?.rules ?? []).map((r) => ({ value: r.id, label: r.name })),
  ];

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const n: Tab = tab === "detections" ? "rules" : "detections";
    setTab(n);
    setTimeout(() => document.getElementById(`tab-${n}`)?.focus(), 0);
  };

  if (rules && rules.monitored_services === 0 && summary?.unacknowledged === 0) {
    return (
      <>
        <PageHeading title="ERRORS" />
        <EmptyState
          title="監視対象がありません"
          description="log_paths を持ち、検知ルールが適用されるサービスがないため、エラー検知は行われていません。config/apps.yaml のサービスにログのパスを設定してください。"
        >
          <pre className="border-primary/30 bg-background/70 border p-3 text-left text-xs">{`services:\n  - id: backend\n    log_paths:\n      - logs/backend.log`}</pre>
        </EmptyState>
      </>
    );
  }

  const ok = data !== null && !loadErr;
  const tabBtn = (id: Tab, label: React.ReactNode) => (
    <Button
      id={`tab-${id}`}
      type="button"
      role="tab"
      aria-selected={tab === id}
      aria-controls={`panel-${id}`}
      tabIndex={tab === id ? 0 : -1}
      variant={tab === id ? "default" : "secondary"}
      shape="flat"
      className={SMALL}
      onClick={() => setTab(id)}
    >
      {label}
    </Button>
  );

  return (
    <>
      <PageHeading
        title="ERRORS"
        description="ログからルールに一致したエラーを検知して表示します。"
      />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </div>

      <section aria-label="検知の概要" className="mb-6 flex flex-col gap-3">
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <li className="border-primary/30 bg-background/70 border p-4">
            <span className="text-foreground/70 flex items-center gap-1.5 text-xs">
              <CircleX size={14} aria-hidden="true" />
              未確認 error
            </span>
            <p
              className={`text-3xl font-bold tabular-nums ${summary?.error ? "text-rose-300" : ""}`}
            >
              {summary ? summary.error : "—"}
            </p>
          </li>
          <li className="border-primary/30 bg-background/70 border p-4">
            <span className="text-foreground/70 flex items-center gap-1.5 text-xs">
              <TriangleAlert size={14} aria-hidden="true" />
              未確認 warn
            </span>
            <p
              className={`text-3xl font-bold tabular-nums ${summary?.warn ? "text-amber-300" : ""}`}
            >
              {summary ? summary.warn : "—"}
            </p>
          </li>
          <li className="border-primary/30 bg-background/70 col-span-2 border p-4 md:col-span-1">
            <span className="text-foreground/70 flex items-center gap-1.5 text-xs">
              <Clock size={14} aria-hidden="true" />
              最終検知
            </span>
            {summary?.last_detected_at ? (
              <>
                <p className="text-xl font-bold">
                  <time
                    dateTime={summary.last_detected_at}
                    title={absTime(summary.last_detected_at)}
                  >
                    {relTime(summary.last_detected_at, now)}
                  </time>
                </p>
                <span className="text-foreground/60 text-xs">
                  {absTime(summary.last_detected_at)}
                </span>
              </>
            ) : (
              <p className="text-xl font-bold">—</p>
            )}
          </li>
        </ul>
        {summary && (
          <div
            role="group"
            aria-label="アプリごとの未確認件数(押すとそのアプリで絞り込み)"
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <span className="text-foreground/70">アプリ別の未確認</span>
            {perApp.length === 0
              ? dim("なし")
              : perApp.map((a) => (
                  <Button
                    key={a.app_id}
                    type="button"
                    shape="flat"
                    variant={filter.app === a.app_id ? "default" : "secondary"}
                    className="px-4 py-1 text-xs"
                    aria-pressed={filter.app === a.app_id}
                    onClick={() => {
                      setTab("detections");
                      setF({
                        app: filter.app === a.app_id ? "" : a.app_id,
                        service: "",
                        rule: "",
                      });
                    }}
                  >
                    <span className="font-mono">{a.app_name}</span>
                    <b className="ms-2 tabular-nums">{a.error + a.warn}</b>
                  </Button>
                ))}
            {rules && (
              <span className="text-foreground/60 ms-auto">
                監視中 {rules.monitored_services} サービス
              </span>
            )}
          </div>
        )}
      </section>

      <div
        role="tablist"
        aria-label="エラー検知"
        onKeyDown={onTabKey}
        className="mb-4 flex flex-wrap gap-2"
      >
        {tabBtn(
          "detections",
          <>
            検知結果
            {summary && summary.unacknowledged > 0 && (
              <span className="bg-destructive text-destructive-foreground ms-2 px-1.5 text-xs">
                {summary.unacknowledged}
              </span>
            )}
          </>,
        )}
        {tabBtn("rules", "ルール")}
      </div>

      {tab === "rules" ? (
        <div id="panel-rules" role="tabpanel" aria-labelledby="tab-rules">
          {rules ? (
            <RulesPanel rules={rules} />
          ) : rulesErr ? (
            <ErrorState title="ルールを取得できません" onRetry={() => void loadRules()} />
          ) : (
            <Skeleton />
          )}
        </div>
      ) : (
        <div
          id="panel-detections"
          role="tabpanel"
          aria-labelledby="tab-detections"
          className="flex flex-col gap-4"
        >
          <section aria-label="フィルタ" className={`${CARD} flex flex-col gap-3`}>
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                label="アプリ"
                items={appItems}
                value={filter.app || ALL}
                onChange={(v) => setF({ app: v === ALL ? "" : v, service: "", rule: "" })}
              />
              <SelectField
                label="サービス"
                items={svcItems}
                value={filter.service || ALL}
                disabled={!filter.app}
                onChange={(v) => setF({ service: v === ALL ? "" : v })}
              />
              <SelectField
                label="ルール"
                items={ruleItems}
                value={filter.rule || ALL}
                disabled={!filter.app}
                onChange={(v) => setF({ rule: v === ALL ? "" : v })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <RadioGroupRoot
                value={filter.severity || ALL}
                onValueChange={({ value }) =>
                  setF({ severity: value === ALL || !value ? "" : (value as Severity) })
                }
                orientation="horizontal"
                className="flex-row flex-wrap items-center gap-x-4 gap-y-2"
              >
                <RadioGroupLabel className="text-xs">重要度</RadioGroupLabel>
                {[
                  [ALL, "すべて"],
                  ["error", "error"],
                  ["warn", "warn"],
                ].map(([v, l]) => (
                  <RadioGroupItem key={v} value={v}>
                    <RadioGroupItemControl />
                    <RadioGroupItemText>{l}</RadioGroupItemText>
                  </RadioGroupItem>
                ))}
              </RadioGroupRoot>
              <SwitchRoot
                checked={filter.includeAck}
                onCheckedChange={(d: { checked: boolean }) => setF({ includeAck: d.checked })}
              >
                <SwitchControl />
                <SwitchLabel>確認済みも表示</SwitchLabel>
              </SwitchRoot>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-foreground/70 text-xs">
                {ok &&
                  `${shown.length} 件表示(うち未確認 ${shownUnack.length} 件)${
                    data.total > events.length ? ` ・ 新しい ${events.length} 件まで表示` : ""
                  }`}
              </span>
              <span className="ms-auto flex flex-wrap gap-2">
                {filtered && (
                  <Button type="button" variant="secondary" className={SMALL} onClick={clear}>
                    <X size={14} aria-hidden="true" />
                    <span className="ms-1.5">フィルタを解除</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="success"
                  className={SMALL}
                  onClick={ackAll}
                  disabled={!ok || busy || shownUnack.length === 0}
                >
                  {busy ? <Spinner size={14} /> : <Check size={14} aria-hidden="true" />}
                  <span className="ms-1.5">すべて確認済みにする</span>
                </Button>
              </span>
            </div>
          </section>

          {ackErr && (
            <div
              role="alert"
              className="border-destructive/60 bg-destructive/10 flex items-center gap-3 border p-3 text-sm"
            >
              <TriangleAlert size={18} aria-hidden="true" />
              確認済みにできませんでした。時間をおいて再試行してください。
            </div>
          )}
          {ok && pending > 0 && shown.length > 0 && (
            <div>
              <Button
                type="button"
                onClick={() => setCutoff(events.reduce((m, e) => Math.max(m, e.id), 0))}
              >
                <ChevronUp size={15} aria-hidden="true" />
                <span className="ms-1.5">新しい検知 {pending} 件を表示</span>
              </Button>
            </div>
          )}

          {loadErr && data === null ? (
            <ErrorState
              title="検知結果を取得できません"
              description="他の画面の操作は引き続き利用できます。"
              onRetry={() => void load(true)}
            >
              <Unplug size={24} aria-hidden="true" />
            </ErrorState>
          ) : data === null ? (
            <Skeleton />
          ) : shown.length === 0 ? (
            !filtered && !filter.includeAck ? (
              <EmptyState
                title="検知されたエラーはありません"
                description="未確認の検知はありません。確認済みの検知は「確認済みも表示」で確認できます。"
              >
                <Check size={26} className="text-teal-300" aria-hidden="true" />
              </EmptyState>
            ) : (
              <EmptyState
                title="条件に一致する検知はありません"
                description="フィルタの条件を変えるか、「確認済みも表示」をオンにしてください。"
              >
                <Search size={24} aria-hidden="true" />
                {filtered && (
                  <Button type="button" onClick={clear}>
                    <X size={14} aria-hidden="true" />
                    <span className="ms-1.5">フィルタを解除</span>
                  </Button>
                )}
              </EmptyState>
            )
          ) : (
            <>
              {loadErr && (
                <p role="status" className="text-foreground/70 flex items-center gap-1.5 text-xs">
                  <TriangleAlert size={13} aria-hidden="true" />
                  最新の検知を取得できませんでした。表示中の一覧はそのままです。
                </p>
              )}
              <ul
                aria-label="検知結果(新しい順)"
                className={`${CARD} flex flex-col divide-y divide-primary/20 py-1`}
              >
                {shown.map((e) => (
                  <DetRow key={e.id} e={e} now={now} busy={busy} onAck={(ids) => void ack(ids)} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <ConfirmDialog cfg={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
