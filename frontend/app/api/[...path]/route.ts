import type { NextRequest } from "next/server";

import { buildBackendUrl, buildForwardHeaders } from "@/lib/proxy";

export const dynamic = "force-dynamic";

const BACKEND_URL = () => process.env.BACKEND_URL ?? "http://127.0.0.1:8900";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = buildBackendUrl(BACKEND_URL(), path, req.nextUrl.search);
  if (url === null) return Response.json({ detail: "不正なパスです" }, { status: 400 });
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const body = hasBody ? await req.text() : "";
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: buildForwardHeaders(req.headers, hasBody, req.method),
      body: body === "" ? undefined : body,
      cache: "no-store",
    });
    return new Response(res.status === 204 ? null : await res.arrayBuffer(), {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ detail: "backend に接続できません" }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
