export type NavItem = {
  href: string;
  label: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "ダッシュボード" },
  { href: "/apps", label: "アプリ" },
  { href: "/logs", label: "ログ" },
  { href: "/resources", label: "リソース" },
];

/** 現在のパスがナビ項目に該当するか。`/` は完全一致、それ以外は配下も含む。 */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
