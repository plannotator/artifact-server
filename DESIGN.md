---
name: Artifact Server (fork)
description: One workbench under one lamp, where only the artifact being read and the row being worked on are lit.
colors:
  bench-ground: "oklch(0.97 0.005 260)"
  bench-raised: "oklch(1 0 0)"
  bench-sunk: "oklch(0.945 0.008 260)"
  bench-hover: "oklch(0.925 0.01 260)"
  stage: "oklch(0.93 0.01 260)"
  sheet: "oklch(1 0 0)"
  ink: "oklch(0.18 0.02 260)"
  ink-soft: "oklch(0.32 0.02 260)"
  ink-muted: "oklch(0.45 0.02 260)"
  rule: "oklch(0.9 0.01 260)"
  rule-strong: "oklch(0.83 0.012 260)"
  violet: "oklch(0.5 0.25 280)"
  violet-ink: "oklch(1 0 0)"
  violet-wash: "oklch(0.94 0.035 280)"
  instrument-teal: "oklch(0.47 0.12 180)"
  instrument-wash: "oklch(0.95 0.025 180)"
  warn: "oklch(0.55 0.16 60)"
  ok: "oklch(0.45 0.15 150)"
  ok-wash: "oklch(0.95 0.03 150)"
  bad: "oklch(0.5 0.2 25)"
  bad-wash: "oklch(0.95 0.025 25)"
  night-ground: "oklch(0.15 0.02 260)"
  night-raised: "oklch(0.2 0.02 260)"
  night-sunk: "oklch(0.12 0.02 260)"
  night-hover: "oklch(0.25 0.02 260)"
  night-stage: "oklch(0.175 0.02 260)"
  night-ink: "oklch(0.92 0.01 260)"
  night-ink-soft: "oklch(0.82 0.015 260)"
  night-ink-muted: "oklch(0.7 0.02 260)"
  night-rule: "oklch(0.26 0.02 260)"
  night-rule-strong: "oklch(0.35 0.02 260)"
  night-violet: "oklch(0.75 0.18 280)"
  night-violet-ink: "oklch(0.15 0.02 260)"
  night-violet-wash: "oklch(0.29 0.07 280)"
  night-instrument-teal: "oklch(0.72 0.12 180)"
  night-instrument-wash: "oklch(0.26 0.04 180)"
  night-warn: "oklch(0.75 0.15 70)"
  night-ok: "oklch(0.72 0.17 150)"
  night-ok-wash: "oklch(0.26 0.05 150)"
  night-bad: "oklch(0.68 0.19 25)"
  night-bad-wash: "oklch(0.27 0.06 25)"
typography:
  headline:
    fontFamily: "Geist Variable, PingFang TC, Noto Sans TC, Microsoft JhengHei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Variable, PingFang TC, Noto Sans TC, Microsoft JhengHei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Geist Variable, PingFang TC, Noto Sans TC, Microsoft JhengHei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist Variable, PingFang TC, Noto Sans TC, Microsoft JhengHei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  meta:
    fontFamily: "Geist Variable, PingFang TC, Noto Sans TC, Microsoft JhengHei, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.45
  fact:
    fontFamily: "Geist Mono Variable, PingFang TC, Noto Sans TC, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "\"tnum\", \"zero\""
rounded:
  chip: "4px"
  pill: "6px"
  card: "8px"
spacing:
  3xs: "2px"
  2xs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  2xl: "64px"
  3xl: "96px"
components:
  button-primary:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.violet-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.bench-hover}"
    textColor: "{colors.ink}"
  button-toggle-pressed:
    backgroundColor: "{colors.violet-wash}"
    textColor: "{colors.violet}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.bench-sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
    height: "32px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    padding: "2px 6px 0"
    height: "48px"
  tab-active:
    textColor: "{colors.ink}"
  catalog-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "10px 14px"
    height: "68px"
  catalog-row-selected:
    backgroundColor: "{colors.bench-hover}"
  panel:
    backgroundColor: "{colors.bench-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px"
  pane-header:
    backgroundColor: "{colors.bench-ground}"
    height: "48px"
  status-bar:
    backgroundColor: "{colors.bench-ground}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.fact}"
    height: "28px"
---

# Design System: Artifact Server (fork)

## Overview

**Creative North Star: "The Workbench Under One Lamp"**

The application is one workbench, and only the work under the lamp is lit: the artifact being read and the row being worked on. Everything else is the bench itself, a neutral near-black (or, by day, an off-white) laid out in a few tonal steps and divided by hairline rules. The third-party artifact sits on a dimmer stage like a white sheet under a soft pool of light; the interface frames it and never restyles it.

Density is that of a desk tool used for long sessions on a large display. Panes meet at 1px seams rather than floating as cards; every screen shares the same 48px header row, the same text-button toolbar, the same underline tabs and the same status-bar height. The workspace, focus mode, the dashboard and settings read as one tool. Colour carries meaning, not decoration: violet is the person, teal is the machine.

This world replaced the earlier Console system; nothing of that system carries over.

**Key Characteristics:**
- Neutral bench in four steps (ground, raised, sunk, hover) plus a separate stage, with no warm or cool cast.
- Two signals only: violet for the person, the selection and the one primary action; teal for agents, times, versions and counts.
- Geist for words, Geist Mono for every measured fact.
- Flat panes joined by 1px rules; the only shadows belong to things that float over the bench.
- Daylight and night are the same bench under different light; both themes are required.

## Colors

A neutral bench with two signals: violet for people and choices, instrument teal for machines and measurements. Every token has a daylight value (`:root`) and a night value (`.dark` on `<html>`); `apps/web/src/themes/plannotator.css` is the source of truth (the Plannotator default theme: cool blue-grey on hue 260, violet primary, teal secondary, amber warn; a further theme adds `:root.theme-<name>` and `:root.theme-<name>.dark`).

### Primary
- **Plannotator Violet** (`violet` by day, `night-violet` by night): the person, the current selection and the one primary action on a screen. It fills one button per screen, underlines the active tab, marks the selected catalog row with a 2px inset bar, tints a pressed toggle (on `violet-wash`), sets the focus outline and the text caret.

### Secondary
- **Instrument Teal** (`instrument-teal` / `night-instrument-teal`): agents, API keys acting, times, versions, counts and the single chart series. It is always set in Geist Mono when it is a value. `instrument-wash` backs a public-link pill and a primary status badge.

### Tertiary
- **Ok Green and Bad Red** (`ok`, `bad` and their washes): diff additions and removals, success and error states, destructive buttons. Never decorative.

### Neutral
- **Bench Ground** (`bench-ground` / `night-ground`): the canvas, pane backgrounds, pane headers and status bars.
- **Bench Raised** (`bench-raised` / `night-raised`): panels, cards, popovers, the floating focus toolbar.
- **Bench Sunk** (`bench-sunk` / `night-sunk`): fields, selects, quiet secondary fills.
- **Bench Hover** (`bench-hover` / `night-hover`): hover fill, and the fill of a selected row.
- **Stage** (`stage` / `night-stage`): the dimmer ground under the artifact, overlaid with the lamp gradient.
- **Sheet** (`sheet`): the white artifact frame, white in both themes because the artifact is third-party light content.
- **Ink, Ink Soft, Ink Muted**: primary text, secondary text and toolbar labels, metadata and inactive tabs.
- **Rule and Rule Strong**: hairline seams between panes and rows; stronger outlines on secondary buttons, pills and the brand mark.

### Named Rules
**The Two Signals Rule.** Violet means a person or a choice; teal means a machine or a measurement. Never swap them, never add a third signal colour, never use either as decoration.

**The One Violet Fill Rule.** One filled violet button per screen. On the comments tab that is the send-all dispatch at the head of the panel. Everything else in a toolbar is a text button.

**The Lamp Rule.** Light falls only on the stage: a radial gradient from above (`--stage-light`) over the stage colour, and the artifact sheet beneath it. Nothing else on the bench gets a gradient or glow.

## Typography

**Display Font:** Geist Variable (Han falls to PingFang TC, Noto Sans TC, Microsoft JhengHei)
**Body Font:** Geist Variable (same stack)
**Label/Mono Font:** Geist Mono Variable (Han falls to PingFang TC, Noto Sans TC)

**Character:** A plain, exact grotesk for words and its mono sibling for facts, so a version id or a timestamp reads as a measurement rather than prose. Both are self-hosted through `@fontsource-variable`; there is no CJK webfont because the CSP serves fonts from self only, so Traditional Chinese (the default language) is set in the system face.

### Hierarchy
- **Headline** (600, 20px, 1.3): page title on dashboard and settings; the largest size in the product.
- **Section** (500 to 600, 16px, 1.45): dialog titles, dashboard stat figures (in Geist Mono), phone-size search text.
- **Title** (600, 14px, 1.2): panel and empty-state headings, the project name in the pane header, the brand label; row titles at 500.
- **Body** (400, 14px, 1.55; 1.7 for Han text): running text, comments, descriptions.
- **Label** (500, 13px, 1.5): buttons, tabs, toggles, field text.
- **Meta** (400, 12px, 1.45): row metadata, captions, table headers.
- **Fact** (Geist Mono 400, 12px, tabular and slashed-zero numerals): times, versions, counts, ids, file sizes, the status bar.

The scale is exactly 12, 13, 14, 16, 20, 24, shared by Tailwind (`@theme inline` in `index.css`) and the workspace stylesheet.

### Named Rules
**The Measured Fact Rule.** Anything measured (a time, version, count, id, size) is set in Geist Mono with tabular numerals, and in instrument teal when it is the subject of the line.

**The Han Leading Rule.** Under `:lang(zh)` headings drop negative tracking and running text opens to 1.7 line height.

## Layout

The workspace is a full-height flex row of panes that meet at 1px seams: a catalog on the left (resizable, default 300px), the preview in the centre, an inspector on the right (resizable, default 360px). There is no permanent navigation sidebar in Review (the product spec forbids one); installation and settings links live in header menus. Every pane opens with a 48px header row (`--as-header-height`), and the preview and catalog close with a 28px status row (`--status-height`) of mono facts, so the rows line up across panes.

Focus mode hides the headers and status bar and gives the whole viewport to the stage; its controls float in a dock at the edge and can collapse to a restore button.

Dashboard and settings share one page shell: the same 48px header with the brand mark in the same place, then a single centred column (max 72rem) under an underline tab row. Six destinations do not earn a sidebar.

Spacing steps are 2, 4, 8, 12, 16, 24, 40, 64, 96px. Inside panes the rhythm is tight (row padding about 10 by 14px, header gaps 4 to 8px); page shells use 24px gutters, 16px under 720px. Under 720px the catalog becomes a full-width drawer over a scrim. Breakpoints in use: 720px (phone), 40rem and 60rem (gutters), plus container queries on the preview and inspector.

## Elevation & Depth

The bench is flat. Depth comes from tonal steps (ground, raised, sunk, hover) and 1px rules; `--shadow-card` is `none`. Shadows exist only for things that float over the bench or lie under the lamp.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 12px 32px -8px var(--color-overlay-shadow), 0 2px 6px -2px var(--color-overlay-shadow)`): popovers, menus, the focus-mode toolbar and its restore button.
- **Sheet** (`box-shadow: 0 -1px 0 color-mix(in oklab, var(--color-ink) 4%, transparent), 0 18px 48px -18px var(--color-overlay-shadow)`): the artifact frame on the stage, and nothing else.

### Named Rules
**The Seams Not Cards Rule.** Panes meet at 1px seams; a pane never gets a shadow or a floating card treatment. Shadows are for overlays and the sheet only.

## Shapes

Three radii: 4px for chips, badges and checkboxes; 6px for buttons, fields, pills, toggles and the brand mark; 8px for panels, cards, the floating focus toolbar and the top corners of the artifact sheet (its bottom edge runs into the status bar). Tabs and catalog rows are square: they are part of the bench, not objects on it. Borders are 1px everywhere; the only 2px lines are the violet tab underline, the violet selected-row marker, presence rings and the focus outline.

## Components

### Buttons
Quiet text controls with one violet exception.
- **Shape:** gently rounded (6px). Heights 24, 28, 32 and 36px (`xs`, `sm`, default, `lg`), with matching square icon sizes.
- **Primary:** violet fill with violet ink, 13px medium. One per screen.
- **Hover / Focus:** primary darkens by mixing 12 to 14% ink into violet; ghost and outline gain the hover fill and full ink. Focus is a 2px violet outline at 2px offset. Pressing moves the button down 1px. Disabled is 55% opacity.
- **Ghost:** the toolbar default; transparent, soft ink, no border.
- **Outline / Secondary:** transparent with a strong-rule border (outline), or a sunk fill (secondary).
- **Destructive:** bad-red border and text on the bad wash.
- **Pressed toggle:** violet wash fill with violet text, identical in the workspace toolbar, focus mode and shadcn `Toggle`.

### Chips
- **Style:** 12px text on a 6px-rounded pill; neutral pills carry only an inset strong-rule ring and muted text; a public-link pill takes instrument wash and teal text. Status badges (4px) come in neutral (sunk fill), primary (teal) and danger (red).
- **State:** a count inside a filter trigger or a tab is teal Geist Mono.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** bench raised.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px rule.
- **Internal Padding:** 20px (16px for the small size). Empty, loading and error states use the same panel at 24px padding with a 14px semibold heading.

### Inputs / Fields
- **Style:** 32px tall (28px small), 6px radius, sunk fill, 1px border in muted ink, 13px text; native selects carry one centred chevron.
- **Focus:** a 2px violet outline drawn inside the field.
- **Error / Disabled:** bad-red border with a faint red ring; 55% opacity when disabled.

### Navigation
- **Tabs:** underline tabs. Transparent, muted 13px medium labels, a 2px transparent bottom border that turns violet on the active tab with full ink. In pane headers they fill the 48px row; the row scrolls and fades at its right edge when tabs overflow. Settings uses the same tabs as its navigation.
- **Header row:** every screen starts with the same 48px row: the 32px brand mark (raised fill, strong-rule border, 6px) and the project or page name at the left, text actions at the right.
- **Mobile:** the catalog becomes a full-width drawer over the scrim; headers keep their height.

### Catalog Row (signature)
The row under the lamp. A full-width, square row about 68px tall, separated by 1px rules, with a 14px medium title and a 12px meta line whose time is teal Geist Mono. Hover takes the hover fill. Selection takes the same neutral fill plus a 2px violet marker inset on the left edge, never a violet background.

### Stage and Sheet (signature)
The preview body is the stage colour under the lamp gradient, with 16 by 20px padding; the artifact frame sits on it as a white sheet with 8px top corners, a 1px rule and the sheet shadow. The frame keeps `color-scheme: light` in both themes.

### Status Bar
A 28px row on the bench ground under a 1px rule, set in Geist Mono at 12px muted ink, carrying the artifact's facts and the reload control. The catalog's footer row matches its height.

### Focus Toolbar
In focus mode the controls float as one raised 8px capsule with the overlay shadow and 2px internal padding; its buttons are ghost text buttons, the active one takes the pressed-toggle treatment, and its comment count is teal mono. It slides off to the edge to collapse (220ms, expo-out) and leaves a restore button.

### Comment Card
A faintly raised block with a 1px rule ring; the selected card takes the violet wash and a violet-tinted ring. Its state tag is violet wash with violet text while open and neutral once resolved.

### Agent Presence Ring
A 2px ring in the agent's colour around the avatar: solid when idle, pulsing (2s) while working, a spinning conic arc (1.2s) while replying, hollow grey at 45% when disconnected. With reduced motion it becomes a static two-tone ring.

## Do's and Don'ts

### Do:
- **Do** take every colour from `tokens.css` through its role (`--color-accent`, `--color-cool`, `--color-paper-*`), and define both the daylight and night value of any new token.
- **Do** keep violet for the person, the selection and the one primary action, and teal for agents, times, versions and counts.
- **Do** set every measured fact in Geist Mono with tabular numerals.
- **Do** open every screen with the 48px header row and the brand mark in the same place, and close panes with the 28px status row.
- **Do** use ghost text buttons in toolbars and the 2px violet underline for the active tab.
- **Do** mark the selected row with the neutral hover fill and the 2px violet inset marker.
- **Do** keep transitions short (120ms for colour, 200ms for state, 380ms at most) on the shared ease-out curve, and honour reduced motion.
- **Do** self-host every font and set styles through CSS files or the CSSOM; the CSP allows `style-src 'self'` and `font-src 'self'` only.

### Don't:
- **Don't** add a second filled violet button to a screen, or fill a selected row with violet.
- **Don't** add a permanent sidebar to Review; settings and dashboard share the one-column page shell.
- **Don't** put shadows on panes, rows or resting panels; shadows belong to overlays and the artifact sheet.
- **Don't** restyle or tint the artifact; it stays on its white sheet in both themes.
- **Don't** load a CJK webfont or any font from a third-party host.
- **Don't** introduce a third signal colour, a gradient outside the stage, or a type size outside 12, 13, 14, 16, 20, 24.
- **Don't** ship a screen that works in only one of the two themes.
