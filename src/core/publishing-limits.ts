/** Maximum number of files declared by one staged publication. */
export const maximumDeclaredFiles = 10_000;

/** Maximum JSON bytes accepted for a file-upload plan or MCP request. */
export const maximumUploadPlanRequestBytes = 16 * 1_024 * 1_024;

/** Maximum characters accepted in one comment thread or reply body. */
export const maximumCommentBodyCharacters = 8_192;

/** Maximum serialized JSON bytes accepted for one comment anchor. */
export const maximumCommentAnchorBytes = 16_384;

/** Maximum comment threads returned by one bounded page. */
export const maximumCommentPageSize = 100;

/** Maximum comment threads carried by one agent dispatch bundle. */
export const maximumDispatchBundleSize = 100;

/** Maximum characters accepted in one dispatch bundle note. */
export const maximumDispatchNoteCharacters = 2_000;

/** Maximum characters accepted in one dispatch failure reason. */
export const maximumDispatchFailureReasonCharacters = 500;

/** Maximum characters accepted for a registered agent's connection key. */
export const maximumAgentConnectionKeyCharacters = 200;

/** Maximum characters accepted for a registered agent's display name. */
export const maximumAgentDisplayNameCharacters = 120;

/** Maximum characters accepted for a registered agent's working directory. */
export const maximumAgentWorkingDirectoryCharacters = 1_024;

/** Milliseconds one dispatch claim lease holds before lazy reclaim to queued. */
export const agentDispatchLeaseMilliseconds = 5 * 60 * 1_000;

/** Heartbeat staleness after which a queued dispatch fails agent_unavailable. */
export const agentUnavailableStalenessMilliseconds = 15 * 60 * 1_000;

/** Window within which a registered agent's claim polling counts as connected. */
export const agentConnectedWindowMilliseconds = 90 * 1_000;

/** Retention for registered-agent rows whose claim polling stopped. */
export const registeredAgentRetentionMilliseconds = 7 * 24 * 60 * 60 * 1_000;
