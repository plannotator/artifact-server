---
version: 1
slug: "src-review"
primary_target: "src/review"
related_targets: ["src/dashboard"]
---

# Surface brief: the Artifact Server application

Scope: every screen of apps/web (workspace, focus mode with interact and annotate, dashboard, settings). Mode: Operate. Audience and job: see PRODUCT.md. Constraints: all functions and flows stay; light and dark themes stay; zh-TW default with English; CSP self-hosted fonts.

## Direction contract

THESIS: One dark workbench where only the work under the lamp is lit: the artifact being read and the row being worked on. Refuses the category default of three equal grey panes with a sprinkled accent; every screen uses the same shell, the same panel, the same control.

OWN-WORLD: Cool blue-grey (Plannotator theme, hue 260) in four steps, hairline 1px rules, Plannotator violet (oklch(0.5 0.25 280) by day, oklch(0.75 0.18 280) by night) for the person, the current selection and the one primary action, soft teal (oklch(0.47 0.12 180) by day, oklch(0.72 0.12 180) by night) for agents, times, versions and counts. Geist for text, Geist Mono for every measured fact. Text buttons in toolbars, one filled violet button per screen, 2px violet marker inside the selected row on a neutral raised fill. Light theme is the same workbench in daylight: off-white paper ground, the same violet and a deeper teal.

STORY: The owner opens the workspace, sees which artifacts need them, reads one under the lamp, selects text, comments, and dispatches to an agent; dashboard and settings read as the same tool, not other products.

FIRST VIEWPORT: Left sidebar 300px (wordmark, project select, search, filter and sort, artifact rows with mono meta); centre toolbar row (title, version, text actions, 標註 toggle) over the lit preview; right inspector 360px (underline tabs; on the comments tab the send-all dispatch heads the panel as its one filled violet control, as the send-all spec orders it, above the filters, composer and comment cards); bottom 28px status bar of mono facts under the preview (the sidebar keeps its own footer row at the same height).

FORM: lamp-pool workbench, position 3 of the dark-workbench list, user recoloured to the T3 Code palette; seed:77fa8acd4601a471.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
