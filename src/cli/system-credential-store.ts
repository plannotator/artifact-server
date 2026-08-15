import {spawn} from "node:child_process";
import path from "node:path";

import {Context, Effect, Redacted, Schema} from "effect";

const maximumHelperOutputBytes = 1_000_000;
const missingExitCode = 2;

/** Expected failure while reading or changing a user credential store. */
export class CliCredentialStoreError extends Schema.TaggedError<CliCredentialStoreError>()(
  "CliCredentialStoreError",
  {
    message: Schema.String,
    operation: Schema.Literals(["delete", "read", "write"]),
    reason: Schema.Literals([
      "backend_unavailable",
      "credential_missing",
      "operation_failed",
    ]),
  },
) {}

/** Secret persistence required by authenticated CLI profiles. */
export interface CliCredentialStoreOperations {
  readonly delete: (
    account: string,
  ) => Effect.Effect<boolean, CliCredentialStoreError>;
  readonly read: (
    account: string,
  ) => Effect.Effect<Redacted.Redacted, CliCredentialStoreError>;
  readonly write: (
    account: string,
    secret: Redacted.Redacted,
  ) => Effect.Effect<void, CliCredentialStoreError>;
}

/** Operating-system credential storage used by the Artifact Server CLI. */
export class CliCredentialStore extends Context.Service<
  CliCredentialStore,
  CliCredentialStoreOperations
>()("artifact-server/cli/CliCredentialStore") {}

export interface SystemCredentialStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** Select the native credential store or an explicitly configured helper. */
export function createSystemCredentialStore(
  options: SystemCredentialStoreOptions = {},
): CliCredentialStoreOperations {
  const environment = options.environment ?? process.env;
  const helper = environment["ARTIFACT_SERVER_CREDENTIAL_HELPER"];
  if (helper !== undefined) {
    if (!path.isAbsolute(helper)) {
      return unavailableStore(
        "ARTIFACT_SERVER_CREDENTIAL_HELPER must be an absolute executable path.",
      );
    }
    return helperStore(helper, environment);
  }

  switch (options.platform ?? process.platform) {
    case "darwin":
      return macOsCredentialStore(environment);
    case "linux":
      return linuxCredentialStore(environment);
    case "win32":
      return windowsCredentialStore(environment);
    default:
      return unavailableStore(
        "This operating system has no supported Artifact Server credential-store adapter.",
      );
  }
}

const credentialService = "artifactserver.com/cli";

function helperStore(
  executable: string,
  environment: NodeJS.ProcessEnv,
): CliCredentialStoreOperations {
  const invoke = (
    operation: "delete" | "read" | "write",
    account: string,
    secret?: Redacted.Redacted,
  ) => runCredentialProcess({
    arguments: [operation],
    environment,
    executable,
    input: credentialHelperInput(account, secret),
    operation,
  });
  return {
    delete: (account) => invoke("delete", account).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.catchTag("CliCredentialStoreError", (error) =>
        error.reason === "credential_missing"
          ? Effect.succeed(false)
          : Effect.fail(error)),
    ),
    read: (account) => invoke("read", account).pipe(
      Effect.map((result) => Redacted.make(result.stdout.trim(), {
        label: "artifact-server-cli-profile",
      })),
    ),
    write: (account, secret) => invoke("write", account, secret).pipe(
      Effect.asVoid,
    ),
  };
}

function credentialHelperInput(
  account: string,
  secret: Redacted.Redacted | undefined,
): string {
  if (secret === undefined) {
    return JSON.stringify({account, service: credentialService});
  }
  return JSON.stringify({
    account,
    secret: Redacted.value(secret),
    service: credentialService,
  });
}

function macOsCredentialStore(
  environment: NodeJS.ProcessEnv,
): CliCredentialStoreOperations {
  return {
    delete: (account) => runCredentialProcess({
      arguments: [
        "delete-generic-password",
        "-a",
        account,
        "-s",
        credentialService,
      ],
      environment,
      executable: "/usr/bin/security",
      input: "",
      missingCodes: new Set([44]),
      operation: "delete",
    }).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.catchTag("CliCredentialStoreError", (error) =>
        error.reason === "credential_missing"
          ? Effect.succeed(false)
          : Effect.fail(error)),
    ),
    read: (account) => runCredentialProcess({
      arguments: [
        "find-generic-password",
        "-a",
        account,
        "-s",
        credentialService,
        "-w",
      ],
      environment,
      executable: "/usr/bin/security",
      input: "",
      missingCodes: new Set([44]),
      operation: "read",
    }).pipe(
      Effect.map((result) => Redacted.make(result.stdout.trim(), {
        label: "artifact-server-cli-profile",
      })),
    ),
    write: (account, secret) => runCredentialProcess({
      arguments: [
        "add-generic-password",
        "-a",
        account,
        "-s",
        credentialService,
        "-U",
        "-w",
      ],
      environment,
      executable: "/usr/bin/security",
      input: `${Redacted.value(secret)}\n`,
      operation: "write",
    }).pipe(Effect.asVoid),
  };
}

function linuxCredentialStore(
  environment: NodeJS.ProcessEnv,
): CliCredentialStoreOperations {
  const attributes = ["service", credentialService, "account"];
  return {
    delete: (account) => runCredentialProcess({
      arguments: ["clear", ...attributes, account],
      environment,
      executable: "secret-tool",
      input: "",
      missingCodes: new Set([missingExitCode]),
      operation: "delete",
    }).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.catchTag("CliCredentialStoreError", (error) =>
        error.reason === "credential_missing"
          ? Effect.succeed(false)
          : Effect.fail(error)),
    ),
    read: (account) => runCredentialProcess({
      arguments: ["lookup", ...attributes, account],
      environment,
      executable: "secret-tool",
      input: "",
      missingCodes: new Set([missingExitCode]),
      operation: "read",
    }).pipe(
      Effect.flatMap((result) => result.stdout.trim().length === 0
        ? missingCredential("read")
        : Effect.succeed(Redacted.make(result.stdout.trim(), {
          label: "artifact-server-cli-profile",
        }))),
    ),
    write: (account, secret) => runCredentialProcess({
      arguments: [
        "store",
        "--label=Artifact Server CLI",
        ...attributes,
        account,
      ],
      environment,
      executable: "secret-tool",
      input: Redacted.value(secret),
      operation: "write",
    }).pipe(Effect.asVoid),
  };
}

function windowsCredentialStore(
  environment: NodeJS.ProcessEnv,
): CliCredentialStoreOperations {
  const invoke = (
    operation: "delete" | "read" | "write",
    account: string,
    secret?: Redacted.Redacted,
  ) => runCredentialProcess({
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsCredentialScript(operation, account),
    ],
    environment,
    executable: "powershell.exe",
    input: secret === undefined ? "" : Redacted.value(secret),
    missingCodes: new Set([missingExitCode]),
    operation,
  });
  return {
    delete: (account) => invoke("delete", account).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.catchTag("CliCredentialStoreError", (error) =>
        error.reason === "credential_missing"
          ? Effect.succeed(false)
          : Effect.fail(error)),
    ),
    read: (account) => invoke("read", account).pipe(
      Effect.map((result) => Redacted.make(result.stdout.trim(), {
        label: "artifact-server-cli-profile",
      })),
    ),
    write: (account, secret) => invoke("write", account, secret).pipe(
      Effect.asVoid,
    ),
  };
}

function windowsCredentialScript(
  operation: "delete" | "read" | "write",
  account: string,
): string {
  const target = `${credentialService}:${account}`.replaceAll("'", "''");
  return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ArtifactServerCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NativeCredential {
    public UInt32 Flags; public UInt32 Type; public string TargetName;
    public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref NativeCredential credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredFree", SetLastError=true)]
  public static extern void Free(IntPtr credential);
}
'@
$target = '${target}'
${windowsOperationBody(operation)}
`;
}

function windowsOperationBody(
  operation: "delete" | "read" | "write",
): string {
  if (operation === "delete") {
    return "if (-not [ArtifactServerCredential]::Delete($target, 1, 0)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 2 }; exit 1 }";
  }
  if (operation === "read") {
    return `
$pointer = [IntPtr]::Zero
if (-not [ArtifactServerCredential]::Read($target, 1, 0, [ref]$pointer)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 2 }; exit 1 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][ArtifactServerCredential+NativeCredential])
  [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2)))
} finally { [ArtifactServerCredential]::Free($pointer) }
`;
  }
  return `
$secret = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::Unicode.GetBytes($secret)
$pointer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  $credential = New-Object ArtifactServerCredential+NativeCredential
  $credential.Type = 1; $credential.TargetName = $target; $credential.UserName = 'Artifact Server CLI'
  $credential.CredentialBlob = $pointer; $credential.CredentialBlobSize = $bytes.Length; $credential.Persist = 2
  if (-not [ArtifactServerCredential]::Write([ref]$credential, 0)) { exit 1 }
} finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($pointer) }
`;
}

function unavailableStore(message: string): CliCredentialStoreOperations {
  const fail = (
    operation: "delete" | "read" | "write",
  ): Effect.Effect<never, CliCredentialStoreError> =>
    Effect.fail(new CliCredentialStoreError({
      message,
      operation,
      reason: "backend_unavailable",
    }));
  return {
    delete: () => fail("delete"),
    read: () => fail("read"),
    write: () => fail("write"),
  };
}

interface CredentialProcessInput {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly input: string;
  readonly missingCodes?: ReadonlySet<number>;
  readonly operation: "delete" | "read" | "write";
}

interface CredentialProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

function runCredentialProcess(
  input: CredentialProcessInput,
): Effect.Effect<CredentialProcessResult, CliCredentialStoreError> {
  return Effect.tryPromise({
    try: () => executeCredentialProcess(input),
    catch: () => new CliCredentialStoreError({
      message: "The operating-system credential store is unavailable.",
      operation: input.operation,
      reason: "backend_unavailable",
    }),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result);
      if (
        result.exitCode === missingExitCode
        || input.missingCodes?.has(result.exitCode) === true
      ) {
        return missingCredential(input.operation);
      }
      return Effect.fail(new CliCredentialStoreError({
        message: "The operating-system credential store rejected the operation.",
        operation: input.operation,
        reason: "operation_failed",
      }));
    }),
  );
}

function executeCredentialProcess(
  input: CredentialProcessInput,
): Promise<CredentialProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.arguments], {
      env: input.environment,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let outputTooLarge = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputTooLarge) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maximumHelperOutputBytes) {
        outputTooLarge = true;
        child.kill();
      }
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (outputTooLarge) {
        reject(new Error("Credential helper output exceeded the safe limit."));
        return;
      }
      resolve({exitCode: exitCode ?? 1, stdout});
    });
    child.stdin.on("error", reject);
    child.stdin.end(input.input, "utf8");
  });
}

function missingCredential(
  operation: "delete" | "read" | "write",
): Effect.Effect<never, CliCredentialStoreError> {
  return Effect.fail(new CliCredentialStoreError({
    message: "The secure credential for this Artifact Server profile is missing.",
    operation,
    reason: "credential_missing",
  }));
}
