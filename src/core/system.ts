import {randomUUID} from "node:crypto";

import type { Clock, IdGenerator } from "./ports.js";
import {randomHex} from "./random.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SystemIdGenerator implements IdGenerator {
  artifactId(): string {
    return `art_${randomUUID()}`;
  }

  contentToken(): string {
    return randomHex(18);
  }

  /** Create one opaque project identity. */
  projectId(): string {
    return `prj_${randomUUID()}`;
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
