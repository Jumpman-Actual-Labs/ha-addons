import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs - ingress serves the page under a per-session
  // /api/hassio_ingress/<token>/ prefix, so nothing can be rooted at "/".
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` against a backend running locally with
    // GAINS_ALLOW_ANY_CLIENT=1 (see gains/CLAUDE.md).
    proxy: {
      "/api": { target: "http://localhost:8099", ws: true },
    },
  },
});
