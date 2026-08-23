import type {NodeGitHistoryConfiguration} from
  "../git-history/node-git-history-configuration.js";

/** Emit optional-provider configuration problems without printing any value. */
export function writeGitHistoryConfigurationWarnings(
  configuration: NodeGitHistoryConfiguration,
): void {
  for (const issue of configuration.issues) {
    process.stderr.write(
      `Git history configuration warning (${issue.reason}): ${issue.message}\n`,
    );
  }
}
