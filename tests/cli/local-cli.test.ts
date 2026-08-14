import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const publicationSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    id: z.string(),
    name: z.string(),
    tags: z.array(z.string()),
  }),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess));
});

describe("local Artifact Server CLI", () => {
  test("starts with private reusable credentials without printing them", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-cli-"));
    try {
      const firstPort = await availablePort();
      const first = startCli(dataDirectory, firstPort);
      const firstReady = await waitForReady(first, firstPort);
      expect(firstReady).toContain(`Artifact Server: http://localhost:${firstPort}`);
      expect(await fetch(`http://127.0.0.1:${firstPort}/health`).then((response) =>
        response.json()
      )).toEqual({status: "ok"});

      const tokenPath = path.join(dataDirectory, "local-api-token");
      const firstToken = await readFile(tokenPath, "utf8");
      expect(firstToken.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
      const browserTokenPath = path.join(dataDirectory, "local-browser-token");
      const browserToken = (await readFile(browserTokenPath, "utf8")).trim();
      expect(browserToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect((await stat(browserTokenPath)).mode & 0o777).toBe(0o600);
      expect(firstReady).not.toContain(firstToken.trim());
      expect(firstReady).not.toContain(browserToken);
      expect(firstReady).not.toContain("Local API token:");
      expect(firstReady).not.toContain("Browser login:");
      await stopProcess(first);

      await chmod(tokenPath, 0o644);
      const secondPort = await availablePort();
      const second = startCli(dataDirectory, secondPort);
      await waitForReady(second, secondPort);
      expect(await readFile(tokenPath, "utf8")).toBe(firstToken);
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
      await stopProcess(second);
    } finally {
      await rm(dataDirectory, {force: true, recursive: true});
    }
  });

  test("rejects an invalid port before creating persistent state", async () => {
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-cli-invalid-"));
    const dataDirectory = path.join(parentDirectory, "data");
    try {
      const result = await runCliToExit(dataDirectory, "not-a-port");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("The port must be an integer between 1 and 65535.");
      await expect(stat(dataDirectory)).rejects.toMatchObject({code: "ENOENT"});
    } finally {
      await rm(parentDirectory, {force: true, recursive: true});
    }
  });

  test("PUB-002-B SCP-007-B: publishes a file, a large finished directory, and a second immutable version through real processes", async () => {
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-publish-cli-"));
    const dataDirectory = path.join(parentDirectory, "data");
    const fixtureDirectory = path.join(parentDirectory, "fixtures");
    const siteDirectory = path.join(fixtureDirectory, "site");
    await mkdir(path.join(siteDirectory, "assets"), {recursive: true});
    const reportPath = path.join(fixtureDirectory, "report.pdf");
    const reportBytes = Buffer.from("%PDF-1.4\nArtifact Server file fixture\n%%EOF\n");
    const firstIndex = "<!doctype html><title>First directory version</title>";
    const largeAsset = Buffer.alloc(1_100_000, 0x5a);
    await Promise.all([
      writeFile(reportPath, reportBytes),
      writeFile(path.join(siteDirectory, "index.html"), firstIndex),
      writeFile(path.join(siteDirectory, "assets/styles.css"), "body { color: navy; }"),
      writeFile(path.join(siteDirectory, "assets/data.bin"), largeAsset),
    ]);

    const port = await availablePort();
    const server = startCli(dataDirectory, port);
    try {
      await waitForReady(server, port);

      const report = await runPublishCliToExit([
        reportPath,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
        "--public",
      ]);
      expect(report.exitCode).toBe(0);
      const reportPublication = publicationSchema.parse(JSON.parse(report.output));
      const openedReport = await fetchPublishedContent(reportPublication.links.version);
      expect(reportPublication.artifact).toMatchObject({
        accessSetting: "public_link",
        name: "report.pdf",
        tags: [],
      });
      expect(openedReport.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await openedReport.arrayBuffer())).toEqual(reportBytes);

      const firstSite = await runPublishCliToExit([
        siteDirectory,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
        "--name",
        "CLI site fixture",
        "--public",
        "--tag",
        "prototype",
      ]);
      expect(firstSite.exitCode).toBe(0);
      const firstPublication = publicationSchema.parse(JSON.parse(firstSite.output));
      expect(firstPublication.artifact).toMatchObject({
        accessSetting: "public_link",
        name: "CLI site fixture",
        tags: ["prototype"],
      });
      expect(await fetchPublishedContent(firstPublication.links.version).then((response) =>
        response.text()
      )).toBe(firstIndex);
      const storedAsset = await fetchPublishedContent(
        new URL("/assets/data.bin", firstPublication.links.version).toString(),
      );
      expect(createHash("sha256").update(Buffer.from(await storedAsset.arrayBuffer())).digest("hex"))
        .toBe(createHash("sha256").update(largeAsset).digest("hex"));

      const secondIndex = "<!doctype html><title>Second directory version</title>";
      await writeFile(path.join(siteDirectory, "index.html"), secondIndex);
      const secondSite = await runPublishCliToExit([
        siteDirectory,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
        "--artifact",
        firstPublication.artifact.id,
        "--expected-version",
        firstPublication.version.id,
      ]);
      expect(secondSite.exitCode).toBe(0);
      const secondPublication = publicationSchema.parse(JSON.parse(secondSite.output));
      expect(secondPublication.artifact.id).toBe(firstPublication.artifact.id);
      expect(secondPublication.version.number).toBe(2);
      expect(await fetchPublishedContent(secondPublication.links.version).then((response) =>
        response.text()
      )).toBe(secondIndex);
      expect((await fetchPublishedContent(firstPublication.links.version)).status).toBe(401);

      const missingEntry = await runPublishCliToExit([
        siteDirectory,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
        "--entry",
        "missing.html",
      ]);
      expect(missingEntry.exitCode).not.toBe(0);
      expect(missingEntry.output).toContain("entry file");

      await mkdir(path.join(siteDirectory, ".git"));
      await writeFile(path.join(siteDirectory, ".git/config"), "[core]\n");
      const unsafePath = await runPublishCliToExit([
        siteDirectory,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
      ]);
      expect(unsafePath.exitCode).not.toBe(0);
      expect(unsafePath.output).toContain(".git");
      await rm(path.join(siteDirectory, ".git"), {recursive: true});

      await symlink(reportPath, path.join(siteDirectory, "linked-report.pdf"));
      const symbolicLink = await runPublishCliToExit([
        siteDirectory,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
        "--public",
      ]);
      expect(symbolicLink.exitCode).not.toBe(0);
      expect(symbolicLink.output).toContain("symbolic links");
      await rm(path.join(siteDirectory, "linked-report.pdf"));

      const specialDirectory = await mkdtemp("/tmp/artifact-server-special-");
      const socketPath = path.join(specialDirectory, "publisher.sock");
      const specialFileServer = createServer();
      await listenOnSocket(specialFileServer, socketPath);
      const specialFile = await runPublishCliToExit([
        specialDirectory,
        "--data",
        dataDirectory,
        "--server",
        `http://127.0.0.1:${port}`,
      ]);
      await closeServer(specialFileServer);
      await rm(specialDirectory, {force: true, recursive: true});
      expect(specialFile.exitCode).not.toBe(0);
      expect(specialFile.output).toContain("regular files and directories");

      const token = (await readFile(path.join(dataDirectory, "local-api-token"), "utf8")).trim();
      expect([
        missingEntry.output,
        unsafePath.output,
        symbolicLink.output,
        specialFile.output,
      ]).not.toContainEqual(expect.stringContaining(token));
      const listed = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts?limit=100`, {
        headers: {Authorization: `Bearer ${token}`},
      });
      await expect(listed.json()).resolves.toMatchObject({
        artifacts: [{artifact: {id: firstPublication.artifact.id}}, {artifact: {id: reportPublication.artifact.id}}],
      });
    } finally {
      await stopProcess(server);
      await rm(parentDirectory, {force: true, recursive: true});
    }
  });
});

function startCli(
  dataDirectory: string,
  port: number,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    path.join(repositoryRoot, "node_modules/.bin/tsx"),
    [
      path.join(repositoryRoot, "src/cli/main.ts"),
      "start",
      "--data",
      dataDirectory,
      "--port",
      String(port),
    ],
    {cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"]},
  );
  runningProcesses.add(child);
  return child;
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const readyText = `Artifact Server: http://localhost:${port}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Artifact Server did not become ready: ${redactToken(output)}`));
    }, 10_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(readyText)) return;
      cleanup();
      resolve(output);
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Artifact Server exited before becoming ready: ${redactToken(output)}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!runningProcesses.delete(child)) return;
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

function runCliToExit(
  dataDirectory: string,
  port: string,
): Promise<ProcessResult> {
  return runCommandToExit([
    "start",
    "--data",
    dataDirectory,
    "--port",
    port,
  ]);
}

function runPublishCliToExit(arguments_: readonly string[]): Promise<ProcessResult> {
  return runCommandToExit(["publish", ...arguments_]);
}

function runCommandToExit(arguments_: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(repositoryRoot, "node_modules/.bin/tsx"),
      [path.join(repositoryRoot, "src/cli/main.ts"), ...arguments_],
      {cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"]},
    );
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        output: redactToken(Buffer.concat(output).toString("utf8")),
      });
    });
  });
}

function fetchPublishedContent(contentUrl: string): Promise<Response> {
  return fetch(contentUrl);
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.safeParse(server.address());
      if (!address.success) {
        server.close();
        reject(new Error("The operating system did not assign a TCP port."));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.data.port);
      });
    });
  });
}

function listenOnSocket(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function redactToken(output: string): string {
  return output
    .replace(/Local API token: [A-Za-z0-9_-]+/gu, "Local API token: [REDACTED]")
    .replace(
      /(Browser login: [^\s?]+\?token=)[A-Za-z0-9_-]+/gu,
      "$1[REDACTED]",
    );
}

interface ProcessResult {
  readonly exitCode: number;
  readonly output: string;
}
