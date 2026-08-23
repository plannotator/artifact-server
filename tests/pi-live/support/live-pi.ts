/**
 * Spawns a REAL `pi` process in a real PTY and drives it like a terminal user.
 *
 * Why node-pty and not `@plannotator/webtui`: webtui's programmatic session
 * control (`createAgentTerminalSession`, `session.sendAgentMessage`) is part of
 * its BROWSER entry — it needs a DOM container, xterm, and a websocket PTY
 * server — while its Node-side surface is `NodePtyBackend`, a thin wrapper over
 * node-pty, and its agent registry has no `pi` entry. Driving node-pty here
 * keeps a Node test out of a browser harness and removes one moving part; the
 * PTY behavior under test is identical.
 */

import {constants} from "node:fs";
import {access, chmod, realpath, stat} from "node:fs/promises";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import path from "node:path";

import {spawn} from "node-pty";

/** Everything one live Pi session needs to start. */
export interface LivePiOptions {
  /** Value for PI_CODING_AGENT_DIR: an isolated agent home. */
  readonly agentDirectory: string;
  /** Absolute path of Pi's CLI entry (`dist/cli.js`). */
  readonly cliPath: string;
  /** The bridge extension loaded with `-e`. */
  readonly extensionPath: string;
  /** Model pattern, `provider/id`, resolved from the temporary models.json. */
  readonly model: string;
  /** Artifact Server origin the bridge registers against. */
  readonly origin: string;
  /** Working directory of the Pi session. */
  readonly projectDirectory: string;
  /** Bearer credential carrying `agent:connect`. */
  readonly token: string;
}

/** A running Pi process under test. */
export interface LivePi {
  /** Everything the terminal has emitted so far. */
  output(): string;
  /** Type one line into Pi's editor and submit it. */
  submit(text: string): void;
  stop(): Promise<void>;
  waitForOutput(pattern: RegExp, timeoutMilliseconds?: number): Promise<void>;
}

const defaultWaitMilliseconds = 60_000;
const pollMilliseconds = 25;
const settleMilliseconds = 1_000;
const exitWaitMilliseconds = 5_000;

/** Pi's footer prints the bare model id once the TUI has painted. */
function modelReadyPattern(model: string): RegExp {
  const identifier = model.split("/").at(-1) ?? model;
  return new RegExp(identifier.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find Pi's CLI entry: an explicit override, the installed `pi` on PATH, or the
 * local checkout's build. The checkout is read-only here — nothing is built.
 */
export async function resolvePiCli(): Promise<string | null> {
  const override = process.env["ARTIFACT_SERVER_PI_LIVE_CLI"]?.trim() ?? "";
  if (override !== "" && await isFile(override)) return override;
  const searchPath = process.env["PATH"] ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, "pi");
    // eslint-disable-next-line no-await-in-loop
    if (await isFile(candidate)) {
      // eslint-disable-next-line no-await-in-loop
      return await realCliPath(candidate);
    }
  }
  const checkout = path.join(
    homedir(),
    "oss-agents/pi/packages/coding-agent/dist/cli.js",
  );
  return await isFile(checkout) ? checkout : null;
}

async function realCliPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

/**
 * node-pty ships a prebuilt `spawn-helper` whose executable bit does not
 * survive npm/pnpm tarball extraction; without it every spawn fails with
 * "posix_spawnp failed". Restore it before the first spawn.
 */
export async function ensurePtyHelperExecutable(): Promise<void> {
  const resolveFromHere = createRequire(import.meta.url);
  const helper = path.join(
    path.dirname(resolveFromHere.resolve("node-pty/package.json")),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  try {
    await access(helper, constants.X_OK);
  } catch {
    await chmod(helper, 0o755);
  }
}

/** Start Pi with the bridge extension loaded and wait until it is interactive. */
export async function startLivePi(options: LivePiOptions): Promise<LivePi> {
  await ensurePtyHelperExecutable();
  const terminal = spawn(process.execPath, [
    options.cliPath,
    "--model",
    options.model,
    "--offline",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--extension",
    options.extensionPath,
  ], {
    cols: 120,
    cwd: options.projectDirectory,
    env: {
      ...process.env,
      ARTIFACT_SERVER_AGENT_NAME: "pi-live-suite",
      ARTIFACT_SERVER_AGENT_TOKEN: options.token,
      ARTIFACT_SERVER_ORIGIN: options.origin,
      PI_CODING_AGENT_DIR: options.agentDirectory,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    name: "xterm-256color",
    rows: 40,
  });

  let output = "";
  let exited = false;
  let markExited: (() => void) | null = null;
  const exit = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  terminal.onData((data) => {
    output += data;
  });
  terminal.onExit(() => {
    exited = true;
    markExited?.();
  });

  const live: LivePi = {
    output: () => output,
    stop: async () => {
      if (!exited) terminal.kill();
      await Promise.race([exit, sleep(exitWaitMilliseconds)]);
    },
    submit: (text) => {
      terminal.write(`${text}\r`);
    },
    waitForOutput: async (pattern, timeoutMilliseconds = defaultWaitMilliseconds) => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (!pattern.test(output)) {
        if (exited) {
          throw new Error(`Pi exited before matching ${pattern.source}.`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Pi never printed ${pattern.source}; last output: ${
              output.slice(-400)
            }`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMilliseconds);
      }
    },
  };

  // The footer carries the active model once the TUI is up; the settle pause
  // covers the last frame so typed input reaches the editor, not the loader.
  await live.waitForOutput(modelReadyPattern(options.model));
  await sleep(settleMilliseconds);
  return live;
}
