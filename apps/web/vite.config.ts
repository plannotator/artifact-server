import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../dist/web",
    rollupOptions: {
      // Three documents ship from this application: the original admin shell,
      // the artifact-first review application, and the isolated review frame
      // that the review application embeds to host the sandboxed artifact
      // viewer. They are separate entries so the frame never carries the
      // application's API client and the application never carries the viewer.
      input: {
        index: new URL("./index.html", import.meta.url).pathname,
        "review-frame": new URL("./review-frame.html", import.meta.url).pathname,
        review: new URL("./review.html", import.meta.url).pathname,
      },
    },
  },
  plugins: [react(), tailwindcss(), documentRoutes()],
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
 * Production publishes extensionless routes for Artifact Server review and
 * its isolated frame. Vite resolves multi-page entries by file name, so
 * development maps the public routes onto those documents and redirects the
 * former route to its canonical replacement.
 */
function documentRoutes(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        if (url === "/workbench" || url.startsWith("/workbench?")) {
          response.statusCode = 308;
          response.setHeader("Location", `/review${url.slice("/workbench".length)}`);
          response.end();
          return;
        }
        for (const route of ["/review-frame", "/review"] as const) {
          if (url === route || url.startsWith(`${route}?`)) {
            request.url = `${route}.html${url.slice(route.length)}`;
            break;
          }
        }
        next();
      });
    },
    name: "artifact-server-document-routes",
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
