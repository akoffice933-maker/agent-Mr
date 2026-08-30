import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Review P2: emit a self-contained server bundle (.next/standalone) with only
  // the node_modules actually reachable from the app. The runtime image then
  // copies that instead of the whole build tree — no dev dependencies, no
  // source, a much smaller attack surface and image size.
  output: "standalone",
};

export default nextConfig;
