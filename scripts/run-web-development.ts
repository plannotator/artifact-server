import {spawn, type ChildProcess} from "node:child_process";

const backend = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/main.ts",
    "start",
    "--data",
    ".artifact-server",
    "--port",
    "8787",
    "--managed",
  ],
  {stdio: "inherit"},
);
const frontend = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--dir", "apps/web", "dev"],
  {stdio: "inherit"},
);

const children = [backend, frontend] as const;
let shuttingDown = false;

for (const child of children) {
  child.once("error", (error) => {
    process.stderr.write(`Development process failed: ${error.message}\n`);
    shutdown(children, 1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal !== null) {
      process.stderr.write(`Development process stopped with ${signal}.\n`);
    }
    shutdown(children, code ?? 1);
  });
}

process.once("SIGINT", () => shutdown(children, 0));
process.once("SIGTERM", () => shutdown(children, 0));

function shutdown(
  processes: readonly ChildProcess[],
  exitCode: number,
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  process.exitCode = exitCode;
}
