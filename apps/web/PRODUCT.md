# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One primary user: the owner of this fork, reviewing work on a Mac desktop. Coding agents (Claude Code, Codex and others) publish HTML reports, plans, proposals and mockups to the server many times a day; the owner opens each one, reads it, selects passages and leaves comments, then dispatches those comments back to an agent. Occasionally the owner shares a public link so someone else can read one artifact. Other members and API keys exist as features but are not the main audience.

## Product Purpose

Artifact Server is a self-hosted place where people and agents publish, review, comment on, version and share the files agents create while building products. This fork adds a dashboard of publishing and review activity and a Traditional Chinese interface. Success: the owner can move through a day's artifacts quickly, read each one without the interface competing with it, and turn reading into precise feedback for an agent.

## Positioning

Every version is immutable and addressable; comments anchor to an exact version; reviewers dispatch comment bundles straight to the agent that will act on them, and the same work is reachable by agents through MCP and WebMCP. It is a review loop between a person and agents, not a file host.

## Operating Context

- Screens: the workspace (artifact list, preview, inspector with comments, details, files, versions and activity), focus mode (full-screen reading, with an interact mode and an annotate mode for selecting text to comment on), the dashboard, and settings (projects, MCP, WebMCP, members, API keys, public links).
- The artifact itself is third-party HTML rendered in a sandboxed frame; the interface frames it but never restyles it. Annotation tools inside the frame come from the Plannotator UI package.
- Used at desk distance on a large display, in long sessions, in both light and dark.

## Capabilities and Constraints

- Every existing function and flow stays; a redesign changes the look and layout only.
- Light and dark themes both stay, switchable by the user.
- The interface defaults to Traditional Chinese and switches to English; terminology follows `apps/web/src/i18n/GLOSSARY.md` (Artifact and Agent untranslated, 派工, 發布, 你). English copy pinned by specs stays word for word.
- CSP: `style-src 'self'` and `font-src 'self'`; fonts are self-hosted, no injected `<style>`, colours set through CSS or CSSOM.
- Stack: React 19, Vite, Tailwind 4, Base UI with shadcn components, Recharts on the dashboard.
- Conformance tests and the browser suite assert behaviour and some copy; they must keep passing.

## Brand Commitments

None binding. The current mark may be replaced.

## Evidence on Hand

Real artifacts in the local server (agent-written reports and proposals in Traditional Chinese), real activity data for the dashboard. No customers, testimonials or metrics to show, and none may be invented.

## Product Principles

1. The artifact is the content; the interface is the frame around it and never competes with it.
2. Reading turns into feedback with as few steps as possible: select, comment, dispatch.
3. One vocabulary across every screen: the same control means the same thing everywhere.
4. Immutable facts (versions, times, ids) are shown precisely and never hidden behind decoration.
