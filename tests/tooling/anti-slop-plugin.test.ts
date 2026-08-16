import {spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterAll, beforeAll, describe, expect, test} from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const rejectedExamples = [
  {
    rule: "no-chained-type-assertions",
    source: 'const value = "known" as unknown as string;\n',
  },
  {
    rule: "no-conditional-empty-object-spread",
    source: "const value = {...(true ? {enabled: true} : {})};\n",
  },
  {
    rule: "no-known-value-widening",
    source: 'const value: unknown = {name: "known"};\n',
  },
  {
    rule: "no-module-mocking",
    source: 'import {vi} from "vitest";\nvi.mock("./dependency.js");\n',
  },
  {
    rule: "no-object-parameters",
    source: "function receive(value: object): void { console.log(value); }\n",
  },
  {
    rule: "no-reflect-apply",
    source: "const sum = (left: number, right: number) => left + right;\nReflect.apply(sum, null, [1, 2]);\n",
  },
  {
    rule: "no-reflect-get",
    source: 'Reflect.get({name: "artifact"}, "name");\n',
  },
  {
    rule: "no-runtime-typeof",
    source: 'const value = typeof process.pid === "number";\n',
  },
  {
    rule: "no-shape-in-symbol-names",
    source: "const requestShape = {name: \"artifact\"};\nconsole.log(requestShape);\n",
  },
  {
    rule: "no-unknown-parameters",
    source: "function receive(value: unknown): void { console.log(value); }\n",
  },
  {
    rule: "no-unknown-returns",
    source: "function receive(): unknown { return 1; }\nreceive();\n",
  },
  {
    rule: "no-unknown-type-aliases",
    source: "type ExternalValue = unknown;\nconst value: ExternalValue = 1;\nconsole.log(value);\n",
  },
  {
    rule: "no-unsafe-dictionary-type",
    source: "const values: Record<string, unknown> = {};\nconsole.log(values);\n",
  },
  {
    rule: "no-widen-then-assert",
    source: 'const known: unknown = {name: "artifact"};\n// SAFETY: Deliberately invalid fixture.\nconst value = known as {name: string};\nconsole.log(value);\n',
  },
  {
    rule: "require-safety-comment-for-type-assertion",
    source: 'const value = "artifact" as string;\nconsole.log(value);\n',
  },
] as const;

describe("anti-slop Oxlint plugin", () => {
  let fixtureDirectory: string;

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-oxlint-"));
  });

  afterAll(async () => {
    await rm(fixtureDirectory, {force: true, recursive: true});
  });

  test("every configured rule rejects its representative unsafe pattern", async () => {
    const fixturePaths = await Promise.all(rejectedExamples.map(async (example) => {
      const fixturePath = path.join(fixtureDirectory, `${example.rule}.ts`);
      await writeFile(fixturePath, example.source, "utf8");
      return fixturePath;
    }));

    const result = await runOxlint(fixturePaths);
    expect(result.exitCode).toBe(1);
    for (const example of rejectedExamples) {
      expect(result.output).toContain(`anti-slop(${example.rule})`);
    }
  });

  test("the plugin accepts precise types, direct calls, parsing, and justified assertions", async () => {
    const fixturePath = path.join(fixtureDirectory, "accepted.ts");
    await writeFile(
      fixturePath,
      [
        "interface ArtifactReference { readonly id: string; }",
        "const reference = {id: \"art_1\"} satisfies ArtifactReference;",
        "const readId = (value: ArtifactReference): string => value.id;",
        "// SAFETY: The fixture establishes the string contract immediately above.",
        "const asserted = readId(reference) as string;",
        "console.log(asserted);",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runOxlint([fixturePath]);
    expect(result.exitCode).toBe(0);
  });
});

interface ProcessResult {
  readonly exitCode: number;
  readonly output: string;
}

function runOxlint(fixturePaths: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(repositoryRoot, "node_modules/.bin/oxlint"),
      ["--config", path.join(repositoryRoot, ".oxlintrc.json"), ...fixturePaths],
      {cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"]},
    );
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        output: Buffer.concat(output).toString("utf8"),
      });
    });
  });
}
