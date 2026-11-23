import {Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis} from "recharts";

import type {Insights} from "@/api/client";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipFrame,
  chartTooltipIndex,
} from "@/components/ui/chart";
import {formatBytes} from "@/lib/presentation";
import {formatDay} from "./dashboard-format.ts";

type GrowthPoint = Insights["storage"]["growth"][number];
type TagCount = Insights["overview"]["tags"][number];

const growthConfig = {
  stored: {color: "var(--insight-series)", label: "Published bytes"},
} satisfies ChartConfig;

const tagConfig = {
  artifacts: {color: "var(--insight-series)", label: "Artifacts"},
} satisfies ChartConfig;

/**
 * Cumulative bytes published over the window: one series, so the card title
 * names it and no legend is drawn. Hover shows the bucket's exact figures.
 */
export function GrowthChart({
  bucket,
  points,
}: {
  readonly bucket: Insights["storage"]["growthBucket"];
  readonly points: readonly GrowthPoint[];
}) {
  return (
    <ChartContainer
      aria-label="Cumulative published bytes over time"
      className="aspect-auto h-56 w-full"
      config={growthConfig}
      role="img"
    >
      <AreaChart data={[...points]} margin={{bottom: 0, left: 4, right: 12, top: 8}}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="day"
          minTickGap={24}
          tickFormatter={formatDay}
          tickLine={false}
        />
        <YAxis
          axisLine={false}
          tickFormatter={formatBytes}
          tickLine={false}
          width={64}
        />
        <ChartTooltip
          content={({activeIndex}) => {
            const index = chartTooltipIndex(activeIndex);
            const point = index === null ? undefined : points[index];
            if (point === undefined) return null;
            return (
              <ChartTooltipFrame
                rows={[
                  {
                    color: "var(--color-stored)",
                    key: "total",
                    label: "Total",
                    value: formatBytes(point.cumulativeBytes),
                  },
                  {
                    color: "transparent",
                    key: "added",
                    label: bucket === "week" ? "Added that week" : "Added that day",
                    value: formatBytes(point.addedBytes),
                  },
                  {
                    color: "transparent",
                    key: "versions",
                    label: "Versions",
                    value: String(point.versions),
                  },
                ]}
                title={bucket === "week" ? `Week of ${formatDay(point.day)}` : formatDay(point.day)}
              />
            );
          }}
          cursor={{strokeWidth: 1}}
        />
        <Area
          dataKey="cumulativeBytes"
          fill="var(--color-stored)"
          fillOpacity={0.12}
          isAnimationActive={false}
          stroke="var(--color-stored)"
          strokeWidth={2}
          type="linear"
        />
      </AreaChart>
    </ChartContainer>
  );
}

/** Live artifacts per tag, largest first, each bar labelled with its count. */
export function TagChart({tags}: {readonly tags: readonly TagCount[]}) {
  return (
    <ChartContainer
      aria-label="Live artifacts per tag"
      className="aspect-auto w-full"
      config={tagConfig}
      role="img"
      style={{height: `${Math.max(2, tags.length) * 32 + 8}px`}}
    >
      <BarChart
        barCategoryGap={8}
        data={[...tags]}
        layout="vertical"
        margin={{bottom: 0, left: 0, right: 32, top: 0}}
      >
        <XAxis dataKey="artifactCount" hide type="number" />
        <YAxis
          axisLine={false}
          dataKey="tag"
          tickLine={false}
          type="category"
          width={120}
        />
        <ChartTooltip
          content={({activeIndex}) => {
            const index = chartTooltipIndex(activeIndex);
            const tag = index === null ? undefined : tags[index];
            if (tag === undefined) return null;
            return (
              <ChartTooltipFrame
                rows={[{
                  color: "var(--color-artifacts)",
                  key: "artifacts",
                  label: "Artifacts",
                  value: String(tag.artifactCount),
                }]}
                title={tag.tag}
              />
            );
          }}
          cursor={false}
        />
        <Bar
          dataKey="artifactCount"
          fill="var(--color-artifacts)"
          isAnimationActive={false}
          radius={[0, 4, 4, 0]}
        >
          <LabelList
            className="fill-foreground"
            dataKey="artifactCount"
            fontSize={12}
            position="right"
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
