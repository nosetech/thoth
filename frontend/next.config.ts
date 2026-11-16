import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 別端末から next dev を開く場合の許可元（カンマ区切り）
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export default nextConfig;
