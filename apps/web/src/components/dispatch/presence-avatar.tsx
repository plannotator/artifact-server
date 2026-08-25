import { useState, type CSSProperties } from "react";

import type { AgentPresence } from "@/api/client";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/presentation";
import piGlyphUrl from "@/review/assets/agents/pi.svg";

/**
 * What the avatar's ring says about the agent right now.
 *
 * Thinking collapses into the working ring: the pulse means "busy on your
 * behalf" whether the agent said so itself or the dispatch state implies it.
 */
export type PresenceRing = "disconnected" | "idle" | "replying" | "working";

/** How one agent kind looks: its bundled mark and its brand accent. */
interface AgentBrand {
  /** CSS color the ring is drawn from. */
  readonly accent: string;
  /** Bundled glyph asset, or null for the neutral letter mark. */
  readonly glyphUrl: string | null;
  /** CSS background of the circle the mark sits on. */
  readonly tile: string;
}

/**
 * The one place a new agent kind registers its look. Pi's brand is
 * monochrome: a white glyph on a dark tile, ringed in the page's own ink.
 */
const brandByKind = new Map<string, AgentBrand>([
  [
    "pi",
    {
      accent: "var(--foreground)",
      glyphUrl: piGlyphUrl,
      tile: "oklch(0.205 0 0)",
    },
  ],
]);

const neutralBrand: AgentBrand = {
  accent: "var(--muted-foreground)",
  glyphUrl: null,
  tile: "var(--muted-foreground)",
};

function agentBrand(kind: string): AgentBrand {
  return brandByKind.get(kind) ?? neutralBrand;
}

/** The ring state one agent record resolves to, heartbeat first. */
export function presenceRing(agent: AgentPresence): PresenceRing {
  if (!agent.connected) return "disconnected";
  const beacon = agent.beacon ?? null;
  if (beacon === "replying") return "replying";
  if (beacon === "thinking") return "working";
  return (agent.activity ?? "idle") === "working" ? "working" : "idle";
}

const ringHeadings = {
  disconnected: "Disconnected",
  idle: "Idle",
  replying: "Replying",
  working: "Working",
} satisfies Record<PresenceRing, string>;

/** One sentence saying what the ring means, in words instead of motion. */
export function presenceSentence(
  agent: AgentPresence,
  ring: PresenceRing,
  now: number,
): string {
  switch (ring) {
    case "idle":
      return "Connected and idle — a send reaches it as one message.";
    case "working":
      return `Working — took a bundle ${
        formatRelativeTime(agent.lastActivityAt ?? agent.lastSeenAt, now)
      }.`;
    case "replying":
      return "Replying — writing back to the annotations it was sent.";
    case "disconnected":
      return `Not connected — last seen ${
        formatRelativeTime(agent.lastSeenAt, now)
      }. Restart the agent in its working directory to reconnect.`;
  }
  return ringHandled(ring);
}

function ringHandled(value: never): never {
  throw new Error(`Unhandled presence ring: ${String(value)}`);
}

const avatarSizes = {
  md: "size-8",
  sm: "size-5",
} as const;

const glyphSizes = {
  md: "size-4",
  sm: "size-2.5",
} as const;

/**
 * The bare presence circle: the agent's brand mark ringed by its state.
 * Decoration only — surfaces that can take a hover put it inside
 * `PresenceAvatar`, which adds the explaining popover.
 */
export function PresenceGlyph({
  className,
  kind,
  ring,
  size = "sm",
}: {
  readonly className?: string;
  readonly kind: string;
  readonly ring: PresenceRing;
  readonly size?: keyof typeof avatarSizes;
}) {
  const brand = agentBrand(kind);
  const accentStyle: CSSProperties & Record<"--presence-accent", string> = {
    "--presence-accent": brand.accent,
  };
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 rounded-full",
        avatarSizes[size],
        className,
      )}
      data-presence-ring={ring}
      style={accentStyle}
    >
      <span className={cn("presence-ring", `presence-ring-${ring}`)} />
      <span
        className={cn(
          "absolute inset-[3px] flex items-center justify-center overflow-hidden rounded-full",
          ring === "disconnected" && "opacity-50 grayscale",
        )}
        style={{ background: brand.tile }}
      >
        {brand.glyphUrl === null
          ? (
            <span className="text-[0.5rem] leading-none font-semibold text-background">
              {kind.slice(0, 1).toUpperCase()}
            </span>
          )
          : <img alt="" className={glyphSizes[size]} src={brand.glyphUrl} />}
      </span>
    </span>
  );
}

/**
 * The live line under a Sent thread's state pill: the agent's avatar plus
 * "working…" or "replying…". Rendered only while the agent is actually on a
 * live state; when the reply lands, the poll replaces this line with it.
 */
export function AgentActivityLine({
  agent,
  now,
}: {
  readonly agent: AgentPresence;
  readonly now: number;
}) {
  const ring = presenceRing(agent);
  if (ring !== "replying" && ring !== "working") return null;
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <PresenceAvatar agent={agent} now={now} />
      <span>
        {`${agent.displayName} is ${ring === "replying" ? "replying…" : "working…"}`}
      </span>
    </p>
  );
}

/**
 * One agent's presence as an avatar whose ring is the state signal: solid
 * when idle, pulsing while working, spinning while replying, hollow and grey
 * when disconnected. Hovering or keyboard-focusing it opens a popover that
 * says the state in words, so color and motion never carry the meaning alone.
 */
export function PresenceAvatar({
  agent,
  now,
  size = "sm",
}: {
  readonly agent: AgentPresence;
  readonly now: number;
  readonly size?: keyof typeof avatarSizes;
}) {
  const [open, setOpen] = useState(false);
  const ring = presenceRing(agent);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={`${agent.displayName} — ${ringHeadings[ring]}`}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        type="button"
      >
        <PresenceGlyph kind={agent.kind} ring={ring} size={size} />
      </PopoverTrigger>
      {/*
        The popover is an explanation, not a destination: it must never steal
        focus on open nor push focus back on close — a returned focus would
        refire the trigger's onFocus and reopen what the pointer just left.
      */}
      <PopoverContent
        align="start"
        className="w-80 gap-2"
        finalFocus={false}
        initialFocus={false}
      >
        <PopoverHeader>
          <PopoverTitle>{agent.displayName}</PopoverTitle>
          <PopoverDescription>
            {presenceSentence(agent, ring, now)}
          </PopoverDescription>
        </PopoverHeader>
        <dl className="grid gap-1 text-xs text-muted-foreground">
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 font-semibold tracking-wide uppercase">
              Agent
            </dt>
            <dd>{agent.kind}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 font-semibold tracking-wide uppercase">
              Last seen
            </dt>
            <dd>{formatRelativeTime(agent.lastSeenAt, now)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 font-semibold tracking-wide uppercase">
              Working directory
            </dt>
            <dd className="min-w-0 font-mono break-all">
              {agent.workingDirectory}
            </dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
}
