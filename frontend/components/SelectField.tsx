"use client";

import { useMemo } from "react";
import { collection } from "@zag-js/select";
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectRoot,
  SelectTrigger,
} from "@/components/ui/select";

export type SelectFieldItem = { label: string; value: string };

/** ラベル付きのセレクト（cosmic-ui の Select）。 */
export function SelectField({
  label,
  items,
  value,
  onChange,
  disabled,
}: {
  label: string;
  items: SelectFieldItem[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const col = useMemo(() => collection({ items }), [items]);
  return (
    <SelectRoot
      collection={col}
      value={[value]}
      onValueChange={(d: { value: string[] }) => d.value[0] && onChange(d.value[0])}
      positioning={{ sameWidth: true }}
      disabled={disabled}
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
