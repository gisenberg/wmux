import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const viteAllowedHosts = (): string[] => {
  const configuredHosts = (process.env.WMUX_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return Array.from(new Set([".ts.net", ...configuredHosts]));
};

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    // The LayoutView chunk deliberately carries the whole ghostty-web
    // terminal engine; it loads lazily, so its size doesn't gate first paint.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // wmux serves these extensionless paths at runtime so reverse proxies do
      // not need to expose Vite source-asset URLs.
      external: (id) => /^\/fonts\/meslo-v3\.4\.0\/(?:regular|bold|italic|bold-italic)$/.test(id),
      output: {
        manualChunks: (id) =>
          /node_modules\/(react|react-dom|scheduler|lucide-react)\//.test(id) ? "vendor" : undefined,
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    allowedHosts: viteAllowedHosts(),
  },
});
