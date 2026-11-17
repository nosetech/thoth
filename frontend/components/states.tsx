import { Button } from "@/components/ui/button";

function StateBox({
  title,
  description,
  role,
  tone = "primary",
  children,
}: {
  title: string;
  description?: string;
  role?: "status" | "alert";
  tone?: "primary" | "destructive";
  children?: React.ReactNode;
}) {
  const toneClass = tone === "destructive" ? "border-destructive/60" : "border-primary/40";
  return (
    <div
      role={role}
      className={`flex flex-col items-center gap-3 border border-dashed px-6 py-12 text-center ${toneClass}`}
    >
      <p className="text-lg font-bold">{title}</p>
      {description && <p className="text-foreground/80 max-w-prose">{description}</p>}
      {children}
    </div>
  );
}

/** 読み込み中。 */
export function LoadingState({ message = "読み込み中..." }: { message?: string }) {
  return (
    <StateBox title={message} role="status">
      <span
        aria-hidden
        className="border-primary size-6 animate-spin rounded-full border-2 border-t-transparent"
      />
    </StateBox>
  );
}

/** データが 0 件のとき。 */
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <StateBox title={title} description={description} />;
}

/** 取得失敗など。`onRetry` を渡すと再試行ボタンを表示する。 */
export function ErrorState({
  title = "エラーが発生しました",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <StateBox title={title} description={description} role="alert" tone="destructive">
      {onRetry && (
        <Button variant="destructive" onClick={onRetry}>
          再試行
        </Button>
      )}
    </StateBox>
  );
}
