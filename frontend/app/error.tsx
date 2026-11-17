"use client";

import { ErrorState } from "@/components/states";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState description="画面の表示中に問題が発生しました。" onRetry={reset} />;
}
