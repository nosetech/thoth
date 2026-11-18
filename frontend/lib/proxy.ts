/** `/api/*` プロキシ用の純粋関数（URL 組み立て・ヘッダ転送）。 */

/** 不正なパスセグメントを含む場合 null を返す。 */
export function buildBackendUrl(base: string, segments: string[], search: string): string | null {
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  const path = segments.map(encodeURIComponent).join("/");
  return `${base}/api/${path}${search}`;
}

const FORWARD_HEADERS = ["accept", "content-type", "origin", "referer"] as const;

/** 存在するヘッダのみ転送する。 */
export function buildForwardHeaders(
  src: Headers,
  hasBody: boolean,
  method?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARD_HEADERS) {
    if (name === "content-type" && !hasBody) continue;
    const v = src.get(name);
    if (v) out[name] = v;
  }
  // 変更系リクエストの CSRF 対策用（backend が Origin/Referer とあわせて検証する）
  if (method && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    out["x-thoth-request"] = "1";
  }
  return out;
}
