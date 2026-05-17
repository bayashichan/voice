import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  async rewrites() {
    return [
      {
        source: '/api/upload',
        destination: 'https://voice-recorder-api.wakaossan2001.workers.dev/upload',
      },
    ];
  },
};

export default nextConfig;
