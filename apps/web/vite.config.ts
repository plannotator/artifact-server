import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../dist/web",
    rollupOptions: {
      // Two documents ship from this application: the management shell, and
      // the review frame the shell embeds to host the sandboxed artifact
      // viewer. They are separate entries so the frame never carries the
      // shell's API client and the shell never carries the viewer.
      input: {
        index: new URL("./index.html", import.meta.url).pathname,
        "review-frame": new URL("./review-frame.html", import.meta.url).pathname,
      },
    },
  },
  plugins: [react(), tailwindcss(), reviewFrameRoute()],
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

/**
 * The server publishes the review frame at `/review-frame`, without the file
 * extension, so the shell embeds one stable path in every environment. The dev
 * server resolves entries by file name, so map the route onto the document.
 */
function reviewFrameRoute(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = request.url ?? "";
        if (url === "/review-frame" || url.startsWith("/review-frame?")) {
          request.url = `/review-frame.html${url.slice("/review-frame".length)}`;
        }
        next();
      });
    },
    name: "artifact-server-review-frame-route",
  };
}

function backendProxy(): ProxyOptions {
  const target = "http://127.0.0.1:8787";
  const developmentProxyCredential =
    process.env["ARTIFACT_SERVER_DEVELOPMENT_PROXY_CREDENTIAL"];
  return {
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        proxyRequest.setHeader("Origin", target);
        if (
          developmentProxyCredential !== undefined
          && request.url?.split("?", 1)[0] === "/auth/local-owner"
        ) {
          proxyRequest.setHeader(
            "X-Artifact-Server-Development-Proxy",
            developmentProxyCredential,
          );
        }
      });
    },
    target,
  };
}
