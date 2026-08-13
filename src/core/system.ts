import { randomBytes, randomUUID } from "node:crypto";

import type { Clock, IdGenerator } from "./ports.js";

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
    return randomBytes(18).toString("hex");
  }

  stagedFileToken(): string {
    return randomBytes(18).toString("hex");
  }

  uploadId(): string {
    return `upl_${randomUUID()}`;
  }

  versionId(): string {
    return `ver_${randomUUID()}`;
  }
}
