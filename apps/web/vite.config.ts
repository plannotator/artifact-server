import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../dist/web",
    rollupOptions: {
      // Review is the only trusted application. The isolated frame remains a
      // separate entry so untrusted artifact rendering never carries the
      // application's API client.
      input: {
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
        const pathname = url.split("?", 1)[0] ?? "";
        const query = url.slice(pathname.length);
        const redirect = legacyReviewRoute(pathname, query);
        if (redirect !== null) {
          response.statusCode = 308;
          response.setHeader("Location", redirect);
          response.end();
          return;
        }
        if (pathname === "/review-frame") {
          request.url = `/review-frame.html${query}`;
        } else if (pathname === "/review" || pathname.startsWith("/review/")) {
          request.url = `/review.html${query}`;
        }
        next();
      });
    },
    name: "artifact-server-document-routes",
  };
}

function legacyReviewRoute(pathname: string, query: string): string | null {
  if (pathname === "/") return `/review${query}`;
  if (pathname === "/projects") return "/review/settings/projects";
  if (pathname === "/administration/members") return "/review/settings/members";
  if (pathname === "/administration/api-keys") return "/review/settings/api-keys";
  if (pathname === "/administration/public-links") return "/review/settings/public-links";
  const match = /^\/projects\/([^/]+)\/artifacts(?:\/([^/]+)(?:\/versions\/([^/]+)\/review)?)?$/u.exec(pathname);
  if (match === null) return null;
  const parameters = new URLSearchParams(query);
  parameters.set("project", decodeURIComponent(match[1] ?? ""));
  if (match[2] !== undefined) parameters.set("artifact", decodeURIComponent(match[2]));
  if (match[3] !== undefined) {
    parameters.set("version", decodeURIComponent(match[3]));
    parameters.set("view", "focus");
  }
  return `/review?${parameters.toString()}`;
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
