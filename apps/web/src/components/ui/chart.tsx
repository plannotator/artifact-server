import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"

const INITIAL_DIMENSION = { width: 320, height: 200 } as const

/**
 * Series shown by one chart. `color` is a CSS color, normally `var(--token)`,
 * so the application theme switches it.
 */
export type ChartConfig = Record<
  string,
  {
    readonly color: string
    readonly label: string
  }
>

/**
 * Responsive frame for one Recharts chart. Each series color becomes
 * `--color-<key>` on the frame, set through CSSOM: the application CSP
 * (`style-src 'self'`) blocks the injected <style> element upstream uses.
 */
function ChartContainer({
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  readonly config: ChartConfig
  readonly children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"]
  readonly initialDimension?: {
    readonly width: number
    readonly height: number
  }
}) {
  const applySeriesColors = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) return
      for (const [key, series] of Object.entries(config)) {
        node.style.setProperty(`--color-${key}`, series.color)
      }
    },
    [config]
  )

  return (
    <div
      data-slot="chart"
      ref={applySeriesColors}
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-surface]:outline-hidden",
        className
      )}
      {...props}
    >
      <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

/** One labelled value inside a chart tooltip. */
export interface ChartTooltipRow {
  readonly color: string
  readonly key: string
  readonly label: string
  readonly value: string
}

/**
 * Tooltip body rendered from the caller's own typed datum. Callers look the
 * hovered datum up by index instead of reading Recharts' untyped payload.
 */
function ChartTooltipFrame({
  className,
  rows,
  title,
}: {
  readonly className?: string
  readonly rows: readonly ChartTooltipRow[]
  readonly title: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
        className
      )}
    >
      <div className="font-medium">{title}</div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div className="flex items-center gap-2" key={row.key}>
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: row.color }}
            />
            <span className="text-muted-foreground">{row.label}</span>
            <span className="ml-auto font-mono font-medium text-foreground tabular-nums">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Translate Recharts' hovered index into a position in the caller's data. */
function chartTooltipIndex(
  activeIndex: RechartsPrimitive.TooltipIndex | undefined
): number | null {
  if (activeIndex === undefined || activeIndex === null) return null
  const index = Number.parseInt(activeIndex, 10)
  return Number.isInteger(index) && index >= 0 ? index : null
}

export { ChartContainer, ChartTooltip, ChartTooltipFrame, chartTooltipIndex }
