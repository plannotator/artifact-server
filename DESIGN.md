# Design: Artifact Server (fork)

The locked system for this fork's web application. Every Hallmark run reads this first and the screens share it. Change it on purpose; the file is the rule.

## System
- Genre: modern-minimal
- Shape of the first page: app screen (`/review`, `/review/dashboard`, `/review/settings/*`)
- Theme: Console (Hallmark catalog), colourway `paper` under the dawn theme and `graphite` under the moon theme (`.dark` on `<html>`)
- Axes: dark/grotesk-sans/chromatic-amber · posture: restrained · modes: light+dark

## Meaning
- Amber is a person, the current selection, focus and the one primary action on a screen.
- Cool blue is an instrument: an agent or API key acting, a time, a version, a count, a chosen chip, the one chart series.
- Ok and bad exist for diffs and status only. Never swap the meanings, never a third signal.

## Tokens
`apps/web/src/hallmark/tokens.css` is the source of truth; `apps/web/src/theme-tokens.css` points shadcn's variables at it and `review/review.css` points the `--as-*` workspace variables at it. The roles:
```css
:root { /* paper */
  --color-paper: oklch(98% 0.006 85);  --color-paper-2: oklch(99.4% 0.004 85);  --color-paper-3: oklch(95.4% 0.008 85);
  --color-ink: oklch(19% 0.01 60);  --color-ink-2: oklch(33% 0.012 60);  --color-muted: oklch(47% 0.012 60);
  --color-rule: oklch(89% 0.01 80);  --color-rule-2: oklch(79% 0.012 80);
  --color-accent: oklch(54% 0.14 70);  --color-accent-ink: oklch(98.5% 0.01 85);  --color-focus: oklch(54% 0.14 70);
  --color-cool: oklch(52% 0.14 250);
  --font-display: "Host Grotesk", ui-sans-serif, system-ui, sans-serif;  --font-body: var(--font-display);
  --font-outlier: "Atkinson Hyperlegible Mono", ui-monospace, monospace;
  --radius-card: 10px;  --radius-pill: 6px;  --radius-chip: 4px;  --rule-hair: 1px;  --shadow-card: none;
}
.dark { /* graphite */
  --color-paper: oklch(17% 0.008 250);  --color-paper-2: oklch(21% 0.009 250);  --color-paper-3: oklch(13.5% 0.007 250);
  --color-ink: oklch(95% 0.005 250);  --color-ink-2: oklch(83% 0.008 250);  --color-muted: oklch(71% 0.01 250);
  --color-rule: oklch(31% 0.01 250);  --color-rule-2: oklch(42% 0.012 250);
  --color-accent: oklch(82% 0.15 80);  --color-accent-ink: oklch(18% 0.04 75);  --color-focus: oklch(82% 0.15 80);
  --color-cool: oklch(77% 0.12 245);
}
```
The spacing scale, the app type scale (ratio 1.2), the easings and the durations are the scaffold's and live in `tokens.css`. Fonts are self-hosted through `@fontsource` (the CSP allows `font-src 'self'` only).

## Type
- Host Grotesk 400 and 500 for everything a person reads; heads 500, sentence case, tracked -0.03em.
- Atkinson Hyperlegible Mono only for what the system measured or wrote: ids, times, versions, byte counts, counts, code. Never a label, a head or a button.
- Labels, table heads, chips and tabs: the body face a step smaller, sentence case, untracked. Functional text 12px or more.

## Surfaces
- Panels are a 1px `--color-rule` edge around `--color-paper-2`, radius 10px; panels that belong together are one surface split by 1px seams. No drop shadows, no glow, no glass; overlays use `--color-scrim`.
- Tables carry horizontal rules only, no outer border; on a phone, settings tables restack each row as a block.
- Every grid track that holds text is `minmax(0, 1fr)`.

## Controls
- Primary: amber fill, `--color-accent-ink` text, 6px radius, 32 to 40px tall, one per screen.
- Secondary: 1px `--color-rule-2` outline on `--color-paper-2`, same radius and height.
- Fields: `--color-paper-3` inside a 1px `--color-muted` edge (3:1), a reserved transparent outline that turns `--color-focus` on focus; the border never changes.
- Chips carry state only: label face inside a 1px rule at 4px, tinted by meaning.
- Focus rings are a 2px outline, instant. Disabled is opacity 0.55, `cursor: not-allowed` and the native attribute.

## Motion
- Character: still. State changes at `--dur-micro`/`--dur-short` on `--ease-out`; no reveal on load; overlay animations run only under `motion-safe`.

## Exports
`apps/web/src/hallmark/tokens.css` in this project, wired into Tailwind v4 and shadcn/ui as above.
