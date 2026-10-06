import {createHash} from "node:crypto";

import {build} from "esbuild";
import type {Plugin, ResolvedConfig} from "vite";

const virtualModule = "virtual:markdown-diagram-sandbox";
const resolvedModule = "\0" + virtualModule;
const developmentPath = "/@markdown-diagram-sandbox.js";

/** Bundle the full renderer as a classic script: opaque frames need no CORS or module imports. */
export function diagramSandboxPlugin(): Plugin {
  let command: ResolvedConfig["command"] = "build";
  let compiled: Promise<string> | undefined;
  const compile = (): Promise<string> => {
    compiled ??= build({
      bundle: true,
      entryPoints: [new URL("./src/review/diagram-sandbox.ts", import.meta.url).pathname],
      format: "iife",
      minify: true,
      platform: "browser",
      target: "es2022",
      write: false,
    }).then((result) => {
      const file = result.outputFiles[0];
      if (file === undefined) throw new Error("The diagram renderer produced no script.");
      return file.text;
    });
    return compiled;
  };
  return {
    name: "markdown-diagram-sandbox",
    configResolved(config) {command = config.command;},
    resolveId(id) {return id === virtualModule ? resolvedModule : null;},
    async load(id) {
      if (id !== resolvedModule) return null;
      const source = await compile();
      const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
      const fileName = `assets/markdown-diagram-sandbox-${digest}.js`;
      if (command === "build") this.emitFile({fileName, source, type: "asset"});
      return `export default ${JSON.stringify(command === "build" ? "/" + fileName : developmentPath)};`;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== developmentPath) {
          next();
          return;
        }
        void compile().then((source) => {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(source);
          return undefined;
        }, next);
      });
    },
  };
}
