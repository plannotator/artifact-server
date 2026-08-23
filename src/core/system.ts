import {randomUUID} from "node:crypto";

import type { Clock, IdGenerator } from "./ports.js";
import {randomHex} from "./random.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SystemIdGenerator implements IdGenerator {
  /** Create one opaque agent dispatch identity. */
  agentDispatchId(): string {
    return `dsp_${randomUUID()}`;
  }

  artifactId(): string {
    return `art_${randomUUID()}`;
  }

  /** Create one opaque comment reply identity. */
  commentReplyId(): string {
    return `rpl_${randomUUID()}`;
  }

  /** Create one opaque comment thread identity. */
  commentThreadId(): string {
    return `cmt_${randomUUID()}`;
  }

  contentToken(): string {
    return randomHex(18);
  }

  /** Create one opaque project identity. */
  projectId(): string {
    return `prj_${randomUUID()}`;
  }

  /** Create one opaque registered-agent identity. */
  registeredAgentId(): string {
    return `agt_${randomUUID()}`;
  }

  stagedFileToken(): string {
    return randomHex(18);
  }

  uploadId(): string {
    return `upl_${randomUUID()}`;
  }

  versionId(): string {
    return `ver_${randomUUID()}`;
  }
}
