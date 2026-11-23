# Interface language (fork-local)

Status: fork-local feature of `ShiGaChenTW/artifact-server`; not proposed upstream.
Backlog: ARTSV-2. Terminology: `apps/web/src/i18n/GLOSSARY.md` (Artifact and Agent stay untranslated; dispatch is 派工; publish is 發布; the reader is 你).

## Contract

- The web application speaks Traditional Chinese (`zh-TW`) by default and English on request. The choice is stored in the browser (`localStorage["artifact-review-locale"]`); any other stored value, or storage that cannot be read, means Traditional Chinese.
- Changing the language reloads the page, so every screen reads in one language. `<html lang>` is `zh-Hant-TW` or `en`.
- The switch sits in the header of the settings screens and the dashboard and names the other language in that language (`English`, `繁體中文`).
- English text is the text the application showed before it had a language setting, word for word, including copy that other specs pin (for example SND-002).
- Dates and relative times follow the interface language; English keeps the browser's own locale.
- Server failures keep their stable codes; Traditional Chinese shows a translated sentence for each known code and falls back to the server's message for an unknown one.
- Not translated, on purpose: the annotation tools inside the review frame (a third-party package), text written for agents (copied review prompts, WebMCP tool descriptions, dispatch bundles), commands and addresses a reader copies, and capability codes.

## Conformance requirements

LANG-001 in `conformance.yml` indexes these promises.
