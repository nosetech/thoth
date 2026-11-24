export type NavItem = {
  href: string;
  label: string;
  icon: "grid" | "apps" | "log" | "alert" | "cpu";
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "DASHBOARD", icon: "grid" },
  { href: "/apps", label: "APPS", icon: "apps" },
  { href: "/logs", label: "LOGS", icon: "log" },
  { href: "/errors", label: "ERRORS", icon: "alert" },
  { href: "/resources", label: "RESOURCES", icon: "cpu" },
];

/** 現在のパスがナビ項目に該当するか。`/` は完全一致、それ以外は配下も含む。 */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
