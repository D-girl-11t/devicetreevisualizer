import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev server binds 0.0.0.0, so a browser on 127.0.0.1 is treated as
  // cross-origin and Next blocks the HMR socket. Without that socket, Turbopack
  // never finishes hydrating and the page stays inert.
  allowedDevOrigins: ["127.0.0.1", "cursor"],
};

export default nextConfig;
