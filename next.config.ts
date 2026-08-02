import type { NextConfig } from "next";

// 静的エクスポート（Cloudflare Pages へ out/ をそのまま配信）。
// output: 'export' では rewrites() が無視されるため、
// アップロード先の Workers URL は utils/config.ts から直接呼んでいる。
const nextConfig: NextConfig = {
  output: 'export',
};

export default nextConfig;
