"use client";

import { useEffect, useState } from "react";
import { PageHeading } from "@/components/PageHeading";
import { ErrorState, LoadingState } from "@/components/states";
import { apiFetch } from "@/lib/api";

type State = { kind: "loading" } | { kind: "ok"; status: string } | { kind: "error" };

export default function Home() {
  const [state, setState] = useState<State>({ kind: "loading" });
  // 再試行のたびに増やして effect を再実行する
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ status: string }>("/api/health")
      .then((d) => !cancelled && setState({ kind: "ok", status: d.status }))
      .catch(() => !cancelled && setState({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  return (
    <>
      <PageHeading title="ダッシュボード" description="登録アプリの稼働状況" />
      {state.kind === "loading" && <LoadingState message="backend に接続中..." />}
      {state.kind === "error" && (
        <ErrorState
          title="backend に接続できません"
          description="backend が起動しているか確認してください。"
          onRetry={retry}
        />
      )}
      {state.kind === "ok" && <p>backend: {state.status}</p>}
    </>
  );
}
