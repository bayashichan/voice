import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  async rewrites() {
    return [
      {
        source: '/api/upload',
        destination: process.env.GAS_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbz_XXXXXXXX/exec', // ユーザーへのプレースホルダー
      },
    ];
  },
};

export default nextConfig;
