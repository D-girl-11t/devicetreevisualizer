import type { NextConfig } from "next";

// Project Pages serves the site at /devicetreevisualizer/. Leave this empty
// for `next dev`, and set it in the GitHub Actions build.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  images: { unoptimized: true },
  // The dev server binds 0.0.0.0, so a browser on 127.0.0.1 is treated as
  // cross-origin and Next blocks the HMR socket. Without that socket, Turbopack
  // never finishes hydrating and the page stays inert.
  allowedDevOrigins: ["127.0.0.1", "cursor"],
};

export default nextConfig;
