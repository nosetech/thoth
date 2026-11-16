import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const BACKEND_URL = () => process.env.BACKEND_URL ?? "http://127.0.0.1:8900";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = `${BACKEND_URL()}/api/${path.join("/")}${req.nextUrl.search}`;
  const hasBody = !["GET", "HEAD"].includes(req.method);
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: hasBody ? { "Content-Type": req.headers.get("content-type") ?? "" } : undefined,
      body: hasBody ? await req.text() : undefined,
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
