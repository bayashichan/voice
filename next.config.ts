import type { NextConfig } from "next";

// 静的エクスポート。本番は Vercel (voice-rho-red.vercel.app) が out/ を配信する。
// 以前は Cloudflare Pages にも配信していたが、二重管理で古い版が残り
// 事故のもとになったため本番は Vercel だけに一本化した。
// output: 'export' では rewrites() が無視されるため、
// アップロード先の Workers URL は utils/config.ts から直接呼んでいる。
const nextConfig: NextConfig = {
  output: 'export',
};

export default nextConfig;
