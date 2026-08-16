import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const profileOutputSchema = z.object({
  accountId: z.string(),
  authentication: z.enum(["api_key", "oauth"]),
  installationId: z.string(),
  name: z.string(),
  origin: z.url(),
  status: z.enum(["authenticated", "invalid", "logged_out"]),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string(), projectId: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
type JsonValue =
  | boolean
  | null
  | number
  | string
  | {readonly [key: string]: JsonValue}
  | readonly JsonValue[];

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess));
});

describe("authenticated CLI profiles and remote publication", () => {
  test("CLI-002-B PUB-012-B: stores a verified profile outside the project and publishes through it after restart", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-profile-"),
    );
    const serverData = path.join(temporaryDirectory, "server");
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const fixture = path.join(temporaryDirectory, "report.txt");
    const site = path.join(temporaryDirectory, "site");
    const environment = await credentialHelperEnvironment(helper, helperState);
    await mkdir(site);
    await writeFile(fixture, "remote profile publication\n");
    await writeFile(path.join(site, "index.html"), "<h1>Remote site</h1>");
    await writeFile(path.join(site, "site.css"), "h1 { color: navy; }");

    const firstPort = await availablePort();
    let server = startServer(serverData, firstPort);
    try {
      await waitForReady(server, firstPort);
      const token = (await readFile(
        path.join(serverData, "local-api-token"),
        "utf8",
      )).trim();
      const firstOrigin = `http://127.0.0.1:${firstPort}`;
      const ciPublication = await runCli(
        ["publish", fixture, "--public", "--profile-data", profileData],
        {
          ...environment,
          ARTIFACT_SERVER_API_TOKEN: token,
          ARTIFACT_SERVER_URL: firstOrigin,
        },
      );
      expect(ciPublication.exitCode).toBe(0);
      expect(publicationSchema.parse(JSON.parse(ciPublication.stdout)).artifact.id)
        .toBeTruthy();
      await expect(readFile(path.join(profileData, "cli-profiles.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});

      const login = await runCli(
        [
          "auth",
          "login",
          firstOrigin,
          "--api-key-stdin",
          "--name",
          "team",
          "--profile-data",
          profileData,
        ],
        environment,
        `${token}\n`,
      );
      expect({exitCode: login.exitCode, stderr: login.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(profileOutputSchema.parse(JSON.parse(login.stdout))).toMatchObject({
        authentication: "api_key",
        name: "team",
        origin: firstOrigin,
        status: "authenticated",
      });
      expect(login.stdout).not.toContain(token);
      expect(login.stderr).not.toContain(token);

      const profileIndex = await readFile(
        path.join(profileData, "cli-profiles.json"),
        "utf8",
      );
      expect(profileIndex).not.toContain(token);
      expect((await stat(path.join(profileData, "cli-profiles.json"))).mode & 0o777)
        .toBe(0o600);
      const helperDatabase = await readFile(helperState, "utf8");
      expect(helperDatabase).toContain(token);

      const status = await runCli(
        ["auth", "status", "team", "--profile-data", profileData],
        environment,
      );
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toContain(token);
      expect(JSON.parse(status.stdout)).toMatchObject({
        profiles: [{name: "team", status: "authenticated"}],
      });

      const firstPublication = await runCli(
        [
          "publish",
          fixture,
          "--profile",
          "team",
          "--profile-data",
          profileData,
          "--public",
        ],
        environment,
      );
      expect(firstPublication.exitCode).toBe(0);
      const firstResult = publicationSchema.parse(JSON.parse(firstPublication.stdout));
      expect(await fetch(firstResult.links.version).then((response) => response.text()))
        .toBe("remote profile publication\n");

      const directoryPublication = await runCli(
        [
          "publish",
          site,
          "--profile",
          "team",
          "--profile-data",
          profileData,
          "--public",
        ],
        environment,
      );
      expect(directoryPublication.exitCode).toBe(0);
      const directoryResult = publicationSchema.parse(
        JSON.parse(directoryPublication.stdout),
      );
      expect(await fetch(directoryResult.links.version).then((response) =>
        response.text()
      )).toBe("<h1>Remote site</h1>");

      await stopProcess(server);
      server = startServer(serverData, firstPort);
      await waitForReady(server, firstPort);
      const afterRestart = await runCli(
        [
          "publish",
          fixture,
          "--profile",
          "team",
          "--profile-data",
          profileData,
          "--public",
        ],
        environment,
      );
      expect(afterRestart.exitCode).toBe(0);
      expect(publicationSchema.parse(JSON.parse(afterRestart.stdout)).artifact.id)
        .not.toBe(firstResult.artifact.id);

      const mismatchedOrigin = await runCli(
        [
          "publish",
          fixture,
          "--profile",
          "team",
          "--server",
          `http://localhost:${firstPort}`,
          "--profile-data",
          profileData,
        ],
        environment,
      );
      expect(mismatchedOrigin.exitCode).not.toBe(0);
      expect(mismatchedOrigin.stderr).toContain("CliProfileError");
      expect(mismatchedOrigin.stderr).not.toContain(token);

      const logout = await runCli(
        ["auth", "logout", "team", "--profile-data", profileData],
        environment,
      );
      expect(logout.exitCode).toBe(0);
      expect(profileOutputSchema.parse(JSON.parse(logout.stdout))).toMatchObject({
        name: "team",
        status: "logged_out",
      });
      expect(logout.stdout).not.toContain(token);
      const removed = await runCli(
        ["auth", "status", "team", "--profile-data", profileData],
        environment,
      );
      expect(removed.exitCode).not.toBe(0);
      expect(removed.stderr).toContain("CliProfileError");
    } finally {
      await stopProcess(server);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 30_000);

  test("CLI-002-F PUB-012-F: rejects an invalid credential without saving it and never sends one profile to another origin", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-profile-failure-"),
    );
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const firstData = path.join(temporaryDirectory, "first-server");
    const secondData = path.join(temporaryDirectory, "second-server");
    const environment = await credentialHelperEnvironment(helper, helperState);
    const firstPort = await availablePort();
    const secondPort = await availablePort();
    const first = startServer(firstData, firstPort);
    const second = startServer(secondData, secondPort);
    try {
      await Promise.all([
        waitForReady(first, firstPort),
        waitForReady(second, secondPort),
      ]);
      const invalidCredential = "invalid-credential-with-sufficient-entropy";
      const rejected = await runCli(
        [
          "auth",
          "login",
          `http://127.0.0.1:${firstPort}`,
          "--api-key-stdin",
          "--profile-data",
          profileData,
        ],
        environment,
        `${invalidCredential}\n`,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).not.toContain(invalidCredential);
      await expect(readFile(path.join(profileData, "cli-profiles.json"), "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});
      await expect(readFile(helperState, "utf8"))
        .rejects.toMatchObject({code: "ENOENT"});

      const firstToken = (await readFile(
        path.join(firstData, "local-api-token"),
        "utf8",
      )).trim();
      const login = await runCli(
        [
          "auth",
          "login",
          `http://127.0.0.1:${firstPort}`,
          "--api-key-stdin",
          "--name",
          "first",
          "--profile-data",
          profileData,
        ],
        environment,
        `${firstToken}\n`,
      );
      expect(login.exitCode).toBe(0);
      const wrongOrigin = await runCli(
        [
          "auth",
          "status",
          "first",
          "--server",
          `http://127.0.0.1:${secondPort}`,
          "--profile-data",
          profileData,
        ],
        environment,
      );
      expect(wrongOrigin.exitCode).not.toBe(0);
      expect(wrongOrigin.stderr).toContain("CliProfileError");
      expect(wrongOrigin.stderr).not.toContain(firstToken);

      const unavailableLogout = await runCli(
        ["auth", "logout", "first", "--profile-data", profileData],
        {
          ...environment,
          ARTIFACT_SERVER_CREDENTIAL_HELPER: path.join(
            temporaryDirectory,
            "missing-helper",
          ),
        },
      );
      expect(unavailableLogout.exitCode).not.toBe(0);
      expect(unavailableLogout.stderr).toContain("credential store is unavailable");
      const retainedProfile = await runCli(
        ["auth", "status", "first", "--profile-data", profileData],
        environment,
      );
      expect(retainedProfile.exitCode).toBe(0);
    } finally {
      await Promise.all([stopProcess(first), stopProcess(second)]);
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 30_000);

  test("CLI-001-B CLI-001-F: completes browser PKCE, refresh, status, and revocation against real HTTP boundaries", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-cli-oauth-"),
    );
    const profileData = path.join(temporaryDirectory, "profiles");
    const helperState = path.join(temporaryDirectory, "credential-helper.json");
    const helper = path.join(temporaryDirectory, "credential-helper.mjs");
    const browser = path.join(temporaryDirectory, "browser.mjs");
    const environment = await credentialHelperEnvironment(helper, helperState);
    await writeBrowserHelper(browser);
    environment["ARTIFACT_SERVER_BROWSER_COMMAND"] = browser;
    const oauth = await startOAuthFixture();
    try {
      const login = await runCli([
        "auth",
        "login",
        oauth.origin,
        "--name",
        "browser-team",
        "--profile-data",
        profileData,
      ], environment);
      expect({exitCode: login.exitCode, stderr: login.stderr}).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(profileOutputSchema.parse(JSON.parse(login.stdout))).toMatchObject({
        authentication: "oauth",
        name: "browser-team",
        status: "authenticated",
      });
      expect(oauth.observations).toMatchObject({
        authorizationCount: 1,
        codeExchangeCount: 1,
        registrationCount: 1,
      });
      expect(oauth.observations.pkceVerified).toBe(true);
      expect(login.stdout).not.toContain("oauth-access-one");
      expect(login.stdout).not.toContain("oauth-refresh-one");

      const status = await runCli([
        "auth",
        "status",
        "browser-team",
        "--profile-data",
        profileData,
      ], environment);
      expect(status.exitCode).toBe(0);
      expect(oauth.observations.refreshCount).toBe(1);
      expect(oauth.observations.lastSessionBearer).toBe("oauth-access-two");
      expect(status.stdout).not.toContain("oauth-access-two");
      expect(status.stdout).not.toContain("oauth-refresh-two");

      const logout = await runCli([
        "auth",
        "logout",
        "browser-team",
        "--profile-data",
        profileData,
      ], environment);
      expect(logout.exitCode).toBe(0);
      expect(JSON.parse(logout.stdout)).toMatchObject({
        remoteRevocation: "confirmed",
        status: "logged_out",
      });
      expect(oauth.observations.revocationCount).toBe(1);
      expect(oauth.observations.revokedToken).toBe("oauth-refresh-two");

      oauth.advertiseWrongResource();
      const rejected = await runCli([
        "auth",
        "login",
        oauth.origin,
        "--name",
        "wrong-resource",
        "--profile-data",
        profileData,
      ], environment);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("authorization metadata is invalid");
      expect(oauth.observations.authorizationCount).toBe(1);
    } finally {
      await oauth.stop();
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  }, 30_000);
});

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function runCli(
  argumentsToPass: readonly string[],
  environment: NodeJS.ProcessEnv,
  standardInput = "",
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliExecutable, [cliEntrypoint, ...argumentsToPass], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exitCode: code ?? -1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
    child.stdin.end(standardInput, "utf8");
  });
}

function startServer(
  dataDirectory: string,
  port: number,
): ChildProcessWithoutNullStreams {
  const child = spawn(cliExecutable, [
    cliEntrypoint,
    "start",
    "--data",
    dataDirectory,
    "--port",
    String(port),
  ], {cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"]});
  runningProcesses.add(child);
  return child;
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const expected = `Artifact Server: http://localhost:${port}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Artifact Server did not become ready."));
    }, 10_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const exit = () => {
      cleanup();
      reject(new Error("Artifact Server exited before becoming ready."));
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
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

async function credentialHelperEnvironment(
  helper: string,
  statePath: string,
): Promise<NodeJS.ProcessEnv> {
  await writeFile(helper, `#!/usr/bin/env node
import {existsSync, readFileSync, writeFileSync} from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const statePath = process.env.CREDENTIAL_HELPER_STATE;
if (statePath === undefined) process.exit(3);
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const operation = process.argv[2];
if (operation === "read") {
  if (!(input.account in state)) process.exit(2);
  process.stdout.write(state[input.account]);
} else if (operation === "write") {
  state[input.account] = input.secret;
  writeFileSync(statePath, JSON.stringify(state));
} else if (operation === "delete") {
  if (!(input.account in state)) process.exit(2);
  delete state[input.account];
  writeFileSync(statePath, JSON.stringify(state));
} else {
  process.exit(3);
}
`, {mode: 0o700});
  await chmod(helper, 0o700);
  return {
    ...process.env,
    ARTIFACT_SERVER_CREDENTIAL_HELPER: helper,
    CREDENTIAL_HELPER_STATE: statePath,
  };
}

async function writeBrowserHelper(target: string): Promise<void> {
  await writeFile(target, `#!/usr/bin/env node
const target = process.argv[2];
if (target === undefined) process.exit(2);
const response = await fetch(target, {redirect: "follow"});
if (!response.ok) process.exit(3);
`, {mode: 0o700});
  await chmod(target, 0o700);
}

interface OAuthFixtureObservations {
  authorizationCount: number;
  codeExchangeCount: number;
  lastSessionBearer: string | null;
  pkceVerified: boolean;
  refreshCount: number;
  registrationCount: number;
  revocationCount: number;
  revokedToken: string | null;
  sessionCount: number;
}

interface OAuthFixture {
  readonly observations: OAuthFixtureObservations;
  readonly origin: string;
  advertiseWrongResource(): void;
  stop(): Promise<void>;
}

async function startOAuthFixture(): Promise<OAuthFixture> {
  const observations: OAuthFixtureObservations = {
    authorizationCount: 0,
    codeExchangeCount: 0,
    lastSessionBearer: null,
    pkceVerified: false,
    refreshCount: 0,
    registrationCount: 0,
    revocationCount: 0,
    revokedToken: null,
    sessionCount: 0,
  };
  let wrongResource = false;
  let codeChallenge: string | null = null;
  let expectedRedirect: string | null = null;
  let origin = "";
  const server = createHttpServer(async (request, response) => {
    const target = new URL(request.url ?? "/", origin);
    if (target.pathname === "/.well-known/oauth-protected-resource/api") {
      sendJson(response, 200, {
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource: wrongResource ? `${origin}/wrong` : `${origin}/api`,
        scopes_supported: ["artifactserver"],
      });
      return;
    }
    if (
      target.pathname === "/.well-known/oauth-authorization-server"
      || target.pathname === "/.well-known/openid-configuration"
    ) {
      sendJson(response, 200, {
        authorization_endpoint: `${origin}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: origin,
        jwks_uri: `${origin}/jwks`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${origin}/revoke`,
        token_endpoint: `${origin}/token`,
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (target.pathname === "/register" && request.method === "POST") {
      observations.registrationCount += 1;
      const registration = z.object({
        redirect_uris: z.array(z.url()).min(1),
      }).passthrough().parse(JSON.parse(await readTextBody(request)));
      sendJson(response, 201, {
        client_id: "artifactserver-cli-test-client",
        redirect_uris: registration.redirect_uris,
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (target.pathname === "/authorize" && request.method === "GET") {
      observations.authorizationCount += 1;
      codeChallenge = target.searchParams.get("code_challenge");
      expectedRedirect = target.searchParams.get("redirect_uri");
      const state = target.searchParams.get("state");
      if (
        codeChallenge === null
        || target.searchParams.get("code_challenge_method") !== "S256"
        || expectedRedirect === null
        || state === null
      ) {
        response.writeHead(400).end();
        return;
      }
      const redirect = new URL(expectedRedirect);
      redirect.searchParams.set("code", "authorization-code-one");
      redirect.searchParams.set("iss", origin);
      redirect.searchParams.set("state", state);
      response.writeHead(302, {Location: redirect.toString()}).end();
      return;
    }
    if (target.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readTextBody(request));
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        observations.codeExchangeCount += 1;
        const verifier = body.get("code_verifier");
        const redirect = body.get("redirect_uri");
        observations.pkceVerified = verifier !== null
          && codeChallenge === createHash("sha256")
            .update(verifier)
            .digest("base64url")
          && redirect === expectedRedirect;
        if (!observations.pkceVerified) {
          sendJson(response, 400, {error: "invalid_grant"});
          return;
        }
        sendJson(response, 200, {
          access_token: "oauth-access-one",
          expires_in: 3_600,
          refresh_token: "oauth-refresh-one",
          scope: "artifactserver offline_access",
          token_type: "Bearer",
        });
        return;
      }
      if (grantType === "refresh_token") {
        observations.refreshCount += 1;
        if (body.get("refresh_token") !== "oauth-refresh-one") {
          sendJson(response, 400, {error: "invalid_grant"});
          return;
        }
        sendJson(response, 200, {
          access_token: "oauth-access-two",
          expires_in: 3_600,
          refresh_token: "oauth-refresh-two",
          scope: "artifactserver offline_access",
          token_type: "Bearer",
        });
        return;
      }
    }
    if (target.pathname === "/api/v1/session" && request.method === "GET") {
      const authorization = request.headers.authorization;
      const bearer = authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length)
        : null;
      observations.lastSessionBearer = bearer;
      observations.sessionCount += 1;
      const accepted = bearer === "oauth-access-two"
        || (bearer === "oauth-access-one" && observations.sessionCount === 1);
      if (!accepted) {
        sendJson(response, 401, {error: {code: "AUTHENTICATION_REQUIRED"}});
        return;
      }
      sendJson(response, 200, {
        authenticationMethod: "bearer",
        principal: {
          authorizedByPrincipalId: null,
          capabilities: [
            "artifact:create",
            "artifact:publish:any",
            "artifact:read",
          ],
          id: "usr_oauth_test",
          installationId: "ins_oauth_test",
          kind: "human",
          membershipRole: "member",
        },
      });
      return;
    }
    if (target.pathname === "/revoke" && request.method === "POST") {
      observations.revocationCount += 1;
      observations.revokedToken = new URLSearchParams(
        await readTextBody(request),
      ).get("token");
      response.writeHead(200).end();
      return;
    }
    if (target.pathname === "/jwks") {
      sendJson(response, 200, {keys: []});
      return;
    }
    response.writeHead(404).end();
  });
  await listenHttp(server);
  const address = assignedAddressSchema.parse(server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return {
    advertiseWrongResource: () => {
      wrongResource = true;
    },
    observations,
    origin,
    stop: () => closeHttp(server),
  };
}

function readTextBody(
  request: IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: JsonValue,
): void {
  response.writeHead(status, {"Content-Type": "application/json"});
  response.end(JSON.stringify(value));
}

function listenHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
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
        if (error === undefined) resolve(address.data.port);
        else reject(error);
      });
    });
  });
}
