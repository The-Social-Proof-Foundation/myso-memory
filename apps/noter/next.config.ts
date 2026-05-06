import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  serverExternalPackages: [
    "@socialproof/memory",
    "@socialproof/mydata",
    "@socialproof/file-storage",
    "@socialproof/myso",
  ],
};

export default nextConfig;
