import {
  monitorEventLoopDelay,
  performance,
  type IntervalHistogram,
} from "node:perf_hooks";

import {z} from "zod";

const controlRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("capacity-stage-start"),
    requestId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("capacity-stage-finish"),
    requestId: z.string().min(1),
  }).strict(),
]);

interface ActiveStage {
  readonly cpuBefore: NodeJS.CpuUsage;
  readonly delay: IntervalHistogram;
  readonly eventLoopBefore: ReturnType<typeof performance.eventLoopUtilization>;
  readonly interval: NodeJS.Timeout;
  peak: NodeJS.MemoryUsage;
  readonly started: NodeJS.MemoryUsage;
}

interface StageStartedMessage {
  readonly garbageCollection: "forced" | "unavailable";
  readonly kind: "capacity-stage-started";
  readonly memory: NodeJS.MemoryUsage;
  readonly requestId: string;
}

interface StageFinishedMessage {
  readonly cpu: {
    readonly systemMilliseconds: number;
    readonly userMilliseconds: number;
  };
  readonly eventLoop: {
    readonly maximumDelayMilliseconds: number;
    readonly meanDelayMilliseconds: number;
    readonly p95DelayMilliseconds: number;
    readonly utilization: number;
  };
  readonly garbageCollection: "forced" | "unavailable";
  readonly kind: "capacity-stage-finished";
  readonly memory: {
    readonly peak: NodeJS.MemoryUsage;
    readonly settled: NodeJS.MemoryUsage;
    readonly started: NodeJS.MemoryUsage;
  };
  readonly requestId: string;
}

interface ControlErrorMessage {
  readonly kind: "capacity-control-error";
  readonly message: string;
  readonly requestId: string;
}

type ControlMessage =
  | ControlErrorMessage
  | StageFinishedMessage
  | StageStartedMessage;

let activeStage: ActiveStage | null = null;

function send(message: ControlMessage): void {
  if (process.send === undefined) {
    throw new Error("The profiled server must run with an IPC control channel.");
  }
  process.send(message);
}

async function collectGarbage(): Promise<"forced" | "unavailable"> {
  if (globalThis.gc === undefined) return "unavailable";
  globalThis.gc();
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return "forced";
}

function memoryMaximum(
  left: NodeJS.MemoryUsage,
  right: NodeJS.MemoryUsage,
): NodeJS.MemoryUsage {
  return {
    arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
    external: Math.max(left.external, right.external),
    heapTotal: Math.max(left.heapTotal, right.heapTotal),
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    rss: Math.max(left.rss, right.rss),
  };
}

async function startStage(requestId: string): Promise<void> {
  if (activeStage !== null) {
    throw new Error("A capacity stage is already being measured.");
  }
  const garbageCollection = await collectGarbage();
  const started = process.memoryUsage();
  const delay = monitorEventLoopDelay({resolution: 10});
  const stage: ActiveStage = {
    cpuBefore: process.cpuUsage(),
    delay,
    eventLoopBefore: performance.eventLoopUtilization(),
    interval: setInterval(() => {
      stage.peak = memoryMaximum(stage.peak, process.memoryUsage());
    }, 10),
    peak: started,
    started,
  };
  stage.interval.unref();
  activeStage = stage;
  delay.enable();
  send({
    garbageCollection,
    kind: "capacity-stage-started",
    memory: started,
    requestId,
  });
}

async function finishStage(requestId: string): Promise<void> {
  const stage = activeStage;
  if (stage === null) {
    throw new Error("No capacity stage is being measured.");
  }
  activeStage = null;
  clearInterval(stage.interval);
  stage.delay.disable();
  stage.peak = memoryMaximum(stage.peak, process.memoryUsage());
  const cpu = process.cpuUsage(stage.cpuBefore);
  const eventLoop = performance.eventLoopUtilization(stage.eventLoopBefore);
  const garbageCollection = await collectGarbage();
  const settled = process.memoryUsage();
  send({
    cpu: {
      systemMilliseconds: cpu.system / 1_000,
      userMilliseconds: cpu.user / 1_000,
    },
    eventLoop: {
      maximumDelayMilliseconds: stage.delay.max / 1_000_000,
      meanDelayMilliseconds: stage.delay.mean / 1_000_000,
      p95DelayMilliseconds: stage.delay.percentile(95) / 1_000_000,
      utilization: eventLoop.utilization,
    },
    garbageCollection,
    kind: "capacity-stage-finished",
    memory: {
      peak: stage.peak,
      settled,
      started: stage.started,
    },
    requestId,
  });
}

process.on("message", (input) => {
  const parsed = controlRequestSchema.safeParse(input);
  if (!parsed.success) return;
  const operation = parsed.data.kind === "capacity-stage-start"
    ? startStage(parsed.data.requestId)
    : finishStage(parsed.data.requestId);
  void operation.catch((cause: unknown) => {
    send({
      kind: "capacity-control-error",
      message: cause instanceof Error ? cause.message : "The capacity control operation failed.",
      requestId: parsed.data.requestId,
    });
  });
});

const compiledCliUrl = new URL("../dist/cli/main.js", import.meta.url);
await import(compiledCliUrl.href);
