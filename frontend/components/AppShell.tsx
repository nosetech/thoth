"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { NAV_ITEMS, isActive } from "@/lib/nav";
import {
  SheetCloseTrigger,
  SheetContent,
  SheetRoot,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="メインメニュー" className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={
              "border-l-2 px-4 py-3 text-base uppercase transition-colors " +
              (active
                ? "border-primary bg-primary/15 text-primary-foreground"
                : "border-transparent text-foreground/70 hover:border-primary/60 hover:text-foreground")
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** 全画面共通のレイアウト。md 以上は固定サイドバー、未満はヘッダー + ドロワーメニュー。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-dvh md:flex">
      <aside className="border-primary/30 bg-background/70 hidden w-60 shrink-0 border-r backdrop-blur md:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 p-4">
          <Link href="/" className="text-primary text-2xl font-bold tracking-widest">
            THOTH
          </Link>
          <NavLinks pathname={pathname} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-primary/30 bg-background/70 sticky top-0 z-40 flex items-center justify-between border-b px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" className="text-primary text-xl font-bold tracking-widest">
            THOTH
          </Link>
          <SheetRoot>
            <SheetTrigger className="mb-0 px-4">
              <Menu className="size-4" aria-label="メニューを開く" />
            </SheetTrigger>
            <SheetContent side="left" className="max-w-64">
              <SheetTitle className="text-primary mb-6 tracking-widest">THOTH</SheetTitle>
              <SheetCloseTrigger />
              <NavLinks pathname={pathname} />
            </SheetContent>
          </SheetRoot>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
