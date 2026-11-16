"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";

export default function Home() {
  const [status, setStatus] = useState("確認中...");

  useEffect(() => {
    apiFetch<{ status: string }>("/api/health")
      .then((d) => setStatus(d.status))
      .catch(() => setStatus("backend に接続できません"));
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1>thoth</h1>
      <p>backend: {status}</p>
    </main>
  );
}
