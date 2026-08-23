/**
 * An isolated Pi installation for one live test: a temporary agent home whose
 * `models.json` points at the suite's scripted model, and an empty project
 * directory to run in. Nothing here touches the developer's own `~/.pi`.
 */

import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

/** Provider and model identifiers the temporary installation exposes. */
export const scriptedModelProvider = "livetest";
export const scriptedModelId = "live-suite-model";
export const scriptedModel = `${scriptedModelProvider}/${scriptedModelId}`;

/** One temporary Pi installation. */
export interface PiEnvironment {
  readonly agentDirectory: string;
  readonly projectDirectory: string;
  remove(): Promise<void>;
}

/** Create the temporary agent home and project directory. */
export async function createPiEnvironment(
  modelBaseUrl: string,
): Promise<PiEnvironment> {
  // Pi reports its resolved working directory, so the suite holds the resolved
  // paths too (macOS temp directories reach the process through a symlink).
  const agentDirectory = await realpath(
    await mkdtemp(path.join(tmpdir(), "artifact-server-pi-live-agent-")),
  );
  const projectDirectory = await realpath(
    await mkdtemp(path.join(tmpdir(), "artifact-server-pi-live-project-")),
  );
  await writeFile(
    path.join(agentDirectory, "models.json"),
    `${JSON.stringify({
      providers: {
        [scriptedModelProvider]: {
          api: "openai-completions",
          apiKey: "artifact-server-pi-live-suite",
          authHeader: true,
          baseUrl: modelBaseUrl,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{
            contextWindow: 128_000,
            cost: {cacheRead: 0, cacheWrite: 0, input: 0, output: 0},
            id: scriptedModelId,
            input: ["text"],
            maxTokens: 4_096,
            name: "Live Suite Model",
            reasoning: false,
          }],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(agentDirectory, "settings.json"),
    `${JSON.stringify({defaultProjectTrust: "never"}, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(projectDirectory, "notes.md"),
    "# Live suite project\n\nA placeholder file so the directory is not empty.\n",
    "utf8",
  );
  return {
    agentDirectory,
    projectDirectory,
    remove: async () => {
      await rm(agentDirectory, {force: true, recursive: true});
      await rm(projectDirectory, {force: true, recursive: true});
    },
  };
}
