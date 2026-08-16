import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../dist/web",
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backendProxy(),
      "/artifacts": backendProxy(),
      "/auth": backendProxy(),
      "/health": backendProxy(),
      "/mcp": backendProxy(),
      "/ready": backendProxy(),
    },
  },
});

function backendProxy(): ProxyOptions {
  const target = "http://127.0.0.1:8787";
  return {
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest) => {
        proxyRequest.setHeader("Origin", target);
      });
    },
    target,
  };
}
