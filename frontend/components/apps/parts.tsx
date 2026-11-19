import { LoaderCircle } from "lucide-react";
import { twMerge } from "tailwind-merge";

export const fmtTime = (d: Date | null) =>
  d ? d.toLocaleTimeString("ja-JP", { hour12: false }) : "—";

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <LoaderCircle size={size} className={twMerge("animate-spin", className)} aria-hidden="true" />
  );
}

export type Tone = "ok" | "muted" | "warn" | "primary" | "danger" | "unsup";

const TONE: Record<Tone, string> = {
  ok: "border-success/60 bg-success/10 text-teal-300",
  muted: "border-foreground/25 bg-foreground/5 text-foreground/70",
  warn: "border-amber-400/60 bg-amber-400/10 text-amber-300",
  primary: "border-primary/60 bg-primary/10 text-sky-300",
  danger: "border-destructive/60 bg-destructive/10 text-rose-300",
  unsup: "border-dashed border-foreground/25 text-foreground/50",
};

/** 状態バッジ。 */
export function Badge({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={twMerge(
        "inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
