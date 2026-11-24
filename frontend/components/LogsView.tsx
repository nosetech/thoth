"use client";

import { Bug, ChevronDown, CircleX, Info, Search, TriangleAlert, Unplug } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { collection } from "@zag-js/select";
import { Badge, Spinner, type Tone } from "@/components/apps/parts";
import { PageHeading } from "@/components/PageHeading";
import { useLogViewer, type LogView } from "@/components/logviewer/useLogViewer";
import { usePolling } from "@/components/shell/usePolling";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { CheckboxControl, CheckboxLabel, CheckboxRoot } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectRoot,
  SelectTrigger,
} from "@/components/ui/select";
import { SwitchControl, SwitchLabel, SwitchRoot } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import {
  LOG_LEVELS,
  countMatches,
  formatBytes,
  olderCount,
  splitByQuery,
  type LogEntry,
  type LogFile,
  type LogLevel,
  type LogService,
} from "@/lib/logs";

const LEVEL: Record<LogLevel, { label: string; tone: Tone; Icon: typeof Info; row: string }> = {
  error: { label: "ERROR", tone: "danger", Icon: CircleX, row: "bg-destructive/10" },
  warn: { label: "WARN", tone: "warn", Icon: TriangleAlert, row: "bg-amber-400/10" },
  info: { label: "INFO", tone: "primary", Icon: Info, row: "" },
  debug: { label: "DEBUG", tone: "muted", Icon: Bug, row: "text-foreground/70" },
};

const CARD = "border border-primary/30 bg-background/70 p-4";
const NOTICE = "border-primary/30 flex flex-wrap items-center gap-3 border p-3";

const fileKey = (f: LogFile | undefined) => (f ? `${f.source}:${f.name}` : "");
const fileLabel = (f: LogFile) =>
  `${f.name}(${f.is_current ? "現在" : "世代"}${f.size !== null ? `・${formatBytes(f.size)}` : ""})`;

type Item = { label: string; value: string };

function Field({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: Item[];
  value: string;
  onChange: (v: string) => void;
}) {
  const col = useMemo(() => collection({ items }), [items]);
  return (
    <SelectRoot
      collection={col}
      value={[value]}
      onValueChange={(d: { value: string[] }) => d.value[0] && onChange(d.value[0])}
      positioning={{ sameWidth: true }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-foreground/70 text-xs">{label}</span>
        <SelectTrigger className="min-w-0" placeholder="選択してください" />
      </div>
      <SelectContent>
        {items.map((it) => (
          <SelectItem key={it.value} item={it}>
            <SelectItemText>{it.label}</SelectItemText>
            <SelectItemIndicator />
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitByQuery(text, query).map((s, i) =>
        s.match ? (
          <mark key={i} className="bg-amber-300/40 text-inherit">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function LogLineRow({ entry, no, query }: { entry: LogEntry; no: number; query: string }) {
  if (entry.kind === "rotated") {
    return (
      <li
        role="separator"
        className="text-primary border-primary/40 my-1 border-y py-1 text-center text-xs"
      >
        ログがローテーションされました({entry.at})— 新しいファイルから続けます
      </li>
    );
  }
  const lv = entry.level ? LEVEL[entry.level] : null;
  return (
    <li className={`flex flex-wrap gap-x-3 px-2 py-0.5 sm:flex-nowrap ${lv?.row ?? ""}`}>
      <span aria-hidden="true" className="text-foreground/40 w-12 shrink-0 text-right select-none">
        {no}
      </span>
      <span className="w-20 shrink-0">
        {lv && (
          <Badge tone={lv.tone} className="px-1.5 py-0 text-[10px]">
            <lv.Icon size={11} aria-hidden="true" />
            <span>{lv.label}</span>
          </Badge>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <Marked text={entry.text} query={query} />
      </span>
    </li>
  );
}

/** 区切り行を除いた行に 1 から連番を振る（画面に読み込んだ範囲内の番号）。 */
function numbered(entries: LogEntry[]): [LogEntry, number][] {
  let n = 0;
  return entries.map((e) => [e, e.kind === "line" ? ++n : 0]);
}

export function LogsView() {
  const [targets, setTargets] = useState<LogService[] | null>(null);
  const [targetsErr, setTargetsErr] = useState(false);
  const [sel, setSel] = useState<{ app: string; svc: string; file: string } | null>(null);
  const [q, setQ] = useState("");
  const [levels, setLevels] = useState<ReadonlySet<LogLevel>>(new Set(LOG_LEVELS));
  const [wrap, setWrap] = useState(true);
  const [tail, setTail] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState("");
  const viewer = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);

  const announce = useCallback((m: string) => {
    setLive("");
    setTimeout(() => setLive(m), 30);
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      setTargets(await apiFetch<LogService[]>("/api/logs"));
      setTargetsErr(false);
    } catch {
      setTargetsErr(true);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void loadTargets(), 0);
    return () => clearTimeout(t);
  }, [loadTargets]);

  const apps = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of targets ?? []) if (!m.has(t.app_id)) m.set(t.app_id, t.app_name);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [targets]);

  // 既定の選択: ログが設定されている最初のサービス
  const defaultSel = useMemo(() => {
    if (!targets?.length) return null;
    const first = targets.find((t) => t.files.length > 0) ?? targets[0];
    return { app: first.app_id, svc: first.service_id, file: fileKey(first.files[0]) };
  }, [targets]);
  const cur = sel ?? defaultSel;

  const services = useMemo(
    () => (targets ?? []).filter((t) => t.app_id === cur?.app),
    [targets, cur],
  );
  const service = services.find((t) => t.service_id === cur?.svc) ?? null;
  const file = service?.files.find((f) => fileKey(f) === cur?.file) ?? service?.files[0] ?? null;
  const isCurrent = !!file?.is_current;

  const filter = useMemo(() => ({ q: q.trim(), levels }), [q, levels]);
  const target = useMemo(
    () =>
      service && file && file.exists
        ? {
            appId: service.app_id,
            serviceId: service.service_id,
            source: file.source,
            name: file.name,
          }
        : null,
    [service, file],
  );

  const follow = tail && isCurrent;
  const v = useLogViewer(target, filter, follow, tick, loadTargets, announce);
  usePolling(follow && v.view.status === "ok", () => setTick((t) => t + 1));

  // 対象を切り替えたら、現在ファイルは追従オン・世代ファイルはオフに戻す
  const selKey = `${cur?.app}/${cur?.svc}/${cur?.file}`;
  const [lastSelKey, setLastSelKey] = useState(selKey);
  if (selKey !== lastSelKey) {
    setLastSelKey(selKey);
    setTail(isCurrent);
  }

  const scrollToBottom = useCallback(() => {
    const el = viewer.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmatic.current = false;
      setAtBottom(true);
    });
  }, []);

  useLayoutEffect(() => {
    if (tail) scrollToBottom();
  }, [v.entries, v.view.status, tail, scrollToBottom]);

  // 遡り読み込み後は、読んでいた位置を保つ
  const prevHeight = useRef(0);
  useLayoutEffect(() => {
    const el = viewer.current;
    if (el && v.prependedTick > 0) {
      programmatic.current = true;
      el.scrollTop += el.scrollHeight - prevHeight.current;
      requestAnimationFrame(() => {
        programmatic.current = false;
      });
    }
  }, [v.prependedTick]);
  const onLoadOlder = () => {
    if (!v.hasMore || olderCount(v.entries.filter((e) => e.kind === "line").length) === 0) return;
    prevHeight.current = viewer.current?.scrollHeight ?? 0;
    setTail(false);
    void v.loadOlder();
  };

  const onScroll = () => {
    const el = viewer.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(dist < 24);
    if (!programmatic.current && tail && dist > 48) {
      setTail(false);
      announce("上にスクロールしたため追従を停止しました");
    }
  };
  const jumpLatest = () => {
    scrollToBottom();
    if (isCurrent) {
      setTail(true);
      announce("追従を再開しました");
    }
  };

  const pick = (appId: string, svcId?: string) => {
    const list = (targets ?? []).filter((t) => t.app_id === appId);
    const s =
      list.find((t) => t.service_id === svcId) ?? list.find((t) => t.files.length > 0) ?? list[0];
    if (s) setSel({ app: appId, svc: s.service_id, file: fileKey(s.files[0]) });
    setQ("");
  };

  const lineCount = v.entries.filter((e) => e.kind === "line").length;
  const matches = useMemo(() => countMatches(v.entries, filter.q), [v.entries, filter.q]);
  const filtered = filter.q !== "" || levels.size < LOG_LEVELS.length;
  const older = olderCount(lineCount);

  // 検索の一致件数は、入力が落ち着いてから 1 回だけ読み上げる
  useEffect(() => {
    if (!filter.q || v.view.status !== "ok") return;
    const t = setTimeout(() => announce(`「${filter.q}」の一致 ${matches} 件`), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.q, v.view.status]);

  if (targetsErr && !targets)
    return (
      <>
        <PageHeading title="ログ" />
        <ErrorState title="ログの一覧を取得できません" onRetry={() => void loadTargets()} />
      </>
    );
  if (!targets)
    return (
      <>
        <PageHeading title="ログ" />
        <LoadingState />
      </>
    );
  if (targets.length === 0)
    return (
      <>
        <PageHeading title="ログ" />
        <EmptyState
          title="アプリが登録されていません"
          description="config/apps.yaml にアプリと log_paths を登録してください。"
        />
      </>
    );

  const hasFiles = !!service && service.files.length > 0;

  return (
    <>
      <PageHeading title="ログ" />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </div>
      <section aria-label="ログの対象" className={`${CARD} mb-4 flex flex-col gap-3`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="アプリ" items={apps} value={cur?.app ?? ""} onChange={(id) => pick(id)} />
          <Field
            label="サービス"
            items={services.map((s) => ({ value: s.service_id, label: s.service_name }))}
            value={cur?.svc ?? ""}
            onChange={(id) => cur && pick(cur.app, id)}
          />
          {hasFiles && (
            <Field
              label="ログファイル"
              items={service.files.map((f) => ({ value: fileKey(f), label: fileLabel(f) }))}
              value={file ? fileKey(file) : ""}
              onChange={(f) => cur && setSel({ ...cur, file: f })}
            />
          )}
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            <span className="text-foreground/70 text-xs">検索</span>
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="キーワード"
              disabled={!hasFiles}
            />
          </label>
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <legend className="text-foreground/70 mb-1 text-xs">レベル</legend>
            {LOG_LEVELS.map((lv) => {
              const m = LEVEL[lv];
              return (
                <CheckboxRoot
                  key={lv}
                  checked={levels.has(lv)}
                  onCheckedChange={(d: { checked: boolean | "indeterminate" }) =>
                    setLevels((s) => {
                      const n = new Set(s);
                      if (d.checked === true) n.add(lv);
                      else n.delete(lv);
                      return n;
                    })
                  }
                >
                  <CheckboxControl />
                  <CheckboxLabel className="flex items-center gap-1">
                    <m.Icon size={13} aria-hidden="true" />
                    {m.label}
                  </CheckboxLabel>
                </CheckboxRoot>
              );
            })}
          </fieldset>
          <SwitchRoot
            checked={wrap}
            onCheckedChange={(d: { checked: boolean }) => setWrap(d.checked)}
          >
            <SwitchControl />
            <SwitchLabel>折り返し</SwitchLabel>
          </SwitchRoot>
          <Button
            type="button"
            aria-pressed={follow}
            disabled={!isCurrent || v.view.status !== "ok"}
            title={file && !isCurrent ? "世代ファイルは追従しません" : undefined}
            onClick={() => (follow ? setTail(false) : jumpLatest())}
          >
            {follow ? "追従中(tail)" : "追従オフ"}
          </Button>
        </div>
        {file && (
          <p className="text-foreground/60 text-xs break-all">
            <code>{file.name}</code>
            {file.size !== null && ` ・ ${formatBytes(file.size)}`}
            {filter.q !== "" && v.view.status === "ok" && ` ・ 一致 ${matches} 件`}
          </p>
        )}
      </section>

      {v.view.status === "ok" && v.hasMore && (
        <div className={`${NOTICE} mb-3`}>
          <Info size={18} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <strong>
              末尾 {lineCount.toLocaleString()} 行のみ表示
              {file?.size != null && `(ファイルサイズ ${formatBytes(file.size)})`}
            </strong>
            <p className="text-foreground/70 text-xs">
              {older === 0
                ? "表示できる上限に達しました。それより前はファイルを直接確認してください。"
                : "大きいファイルは末尾の一部だけを読み込んでいます。"}
            </p>
          </div>
          <Button type="button" onClick={onLoadOlder} disabled={v.loadingOlder || older === 0}>
            {v.loadingOlder ? (
              <Spinner size={15} />
            ) : (
              <ChevronDown className="rotate-180" size={15} aria-hidden="true" />
            )}
            <span className="ms-1.5">さらに前を読み込む</span>
          </Button>
        </div>
      )}
      {v.view.status === "ok" && v.scanLimited && (
        <div role="status" className={`${NOTICE} mb-3 border-amber-400/60 text-amber-300`}>
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>絞り込みの対象はファイルの末尾の一部です</strong>
            <p className="text-xs">
              大きいファイルのため、検索・レベル絞り込みは末尾の約 16MB
              だけを調べました。一致する行がこれより前にある可能性があります。
            </p>
          </div>
        </div>
      )}
      {v.view.status === "ok" && v.followErr && (
        <div role="status" className={`${NOTICE} mb-3 border-amber-400/60 text-amber-300`}>
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <strong>新しい行を取得できませんでした</strong>
            <p className="text-xs">表示中のログはそのままです。次の更新で再試行します。</p>
          </div>
        </div>
      )}

      <div className={`${CARD} relative`}>
        <Body
          service={service}
          file={file}
          view={v.view}
          retry={v.retry}
          lineCount={lineCount}
          filtered={filtered}
          q={filter.q}
          onClear={() => {
            setQ("");
            setLevels(new Set(LOG_LEVELS));
          }}
        >
          <div
            ref={viewer}
            tabIndex={0}
            role="region"
            aria-label={`ログ本文: ${file?.name ?? ""}(${lineCount} 行表示)。矢印キーでスクロールできます`}
            onScroll={onScroll}
            className={`focus-visible:outline-primary max-h-[60vh] min-h-48 overflow-auto font-mono text-xs leading-5 outline-offset-2 focus-visible:outline-2 ${
              wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"
            }`}
          >
            {!v.hasMore && (
              <p className="text-foreground/40 py-1 text-center text-[10px]">— ファイルの先頭 —</p>
            )}
            <ol>
              {numbered(v.entries).map(([e, no]) => (
                <LogLineRow key={e.key} entry={e} no={no} query={filter.q} />
              ))}
            </ol>
          </div>
          {!atBottom && (
            <div className="absolute right-6 bottom-6">
              <Button type="button" onClick={jumpLatest}>
                <ChevronDown size={15} aria-hidden="true" />
                <span className="ms-1.5">最新へ移動</span>
              </Button>
            </div>
          )}
        </Body>
      </div>
      {v.view.status === "ok" && (
        <p className="text-foreground/60 mt-2 flex items-center gap-1.5 text-xs">
          <Info size={13} aria-hidden="true" />
          {isCurrent
            ? follow
              ? "追従中は 5 秒ごとに新しい行を末尾へ追加します。上へスクロールすると追従を止めます。"
              : "追従はオフです。「最新へ移動」または「追従オフ」ボタンで再開できます。"
            : "これはローテーション済みの世代ファイルです(追従しません)。"}
        </p>
      )}
    </>
  );
}

function Body({
  service,
  file,
  view,
  retry,
  lineCount,
  filtered,
  q,
  onClear,
  children,
}: {
  service: LogService | null;
  file: LogFile | null;
  view: LogView;
  retry: () => void;
  lineCount: number;
  filtered: boolean;
  q: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  if (!service || service.files.length === 0) {
    return (
      <EmptyState
        title="このサービスにはログが設定されていません"
        description="config/apps.yaml のサービスに log_paths を指定すると、ここで閲覧できます。"
      >
        <pre className="border-primary/30 bg-background/70 border p-3 text-left text-xs">{`log_paths:\n  - logs/${service?.service_id ?? "service"}.log`}</pre>
      </EmptyState>
    );
  }
  if (file && !file.exists)
    return (
      <ErrorState
        title="ログファイルが見つかりません"
        description={`${file.name} が存在しません。サービスがまだ起動していないか、log_paths のパスが誤っている可能性があります。`}
        onRetry={retry}
      />
    );
  if (view.status === "loading" || view.status === "idle")
    return (
      <div aria-busy="true" role="status" className="flex flex-col gap-2 py-2">
        <span className="sr-only">ログを読み込み中です</span>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="bg-primary/10 h-3.5 animate-pulse"
            style={{ width: `${60 + ((i * 37) % 40)}%` }}
          />
        ))}
      </div>
    );
  if (view.status === "error") {
    if (view.kind === "missing")
      return (
        <ErrorState
          title="ログファイルが見つかりません"
          description="ファイルが移動・削除された可能性があります。"
          onRetry={retry}
        />
      );
    if (view.kind === "denied")
      return (
        <ErrorState
          title="ログファイルを読み取れません"
          description="読み取り権限がありません。ファイルの権限を確認してください。"
          onRetry={retry}
        />
      );
    return (
      <ErrorState
        title="ログを取得できませんでした"
        description="他の画面の操作は引き続き利用できます。"
        onRetry={retry}
      >
        <Unplug size={24} aria-hidden="true" />
      </ErrorState>
    );
  }
  if (lineCount === 0) {
    return (
      <EmptyState
        title={
          q
            ? `「${q}」に一致する行はありません`
            : filtered
              ? "選択したレベルの行はありません"
              : "ログがまだありません"
        }
        description={filtered ? "キーワードやレベルの絞り込みを変えてみてください。" : undefined}
      >
        {filtered && (
          <Button type="button" onClick={onClear}>
            <Search size={14} aria-hidden="true" />
            <span className="ms-1.5">絞り込みをクリア</span>
          </Button>
        )}
      </EmptyState>
    );
  }
  return <>{children}</>;
}
