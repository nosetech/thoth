"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/states";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // 詳細は画面に出さず、ブラウザのコンソールにのみ記録する
    console.error(error);
  }, [error]);

  return <ErrorState description="画面の表示中に問題が発生しました。" onRetry={reset} />;
}
