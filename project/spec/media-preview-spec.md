# Image and video previews

**Status:** Accepted and implemented with local HTTP and browser proof; multi-deployment verification remains open (`PRV-001` through `PRV-005`, August 23, 2026)
**Owner:** Artifact Server web application
**Companion documents:** [Product specification](./artifact-server-product-spec.md), [Local workspace features](./local-workspace-spec.md), [Artifact comments](./artifact-comments-spec.md), [Conformance ledger](./conformance.yml)

## 1. Outcome

The Artifact Server review interface presents an image or video from one exact immutable artifact version in its central preview surface. A person can inspect a media-only artifact, select an image or video inside a multi-file artifact, enter the existing focus view, and open the exact version in its normal content origin.

The browser remains the media engine. Artifact Server does not decode, transform, transcode, resize, generate thumbnails, invent posters, or probe uploaded media. The work is a secure delivery path and a useful native presentation, not a media-processing subsystem.

This slice covers images and video only. Audio and PDF previews remain separate follow-on work. Existing HTML preview behavior stays unchanged.

## 2. User experience

### 2.1 Selecting what to show

The viewer always names one `{projectId, artifactId, versionId, path}` tuple. It never follows the artifact's moving current-version pointer after the version has been selected.

The selected path is resolved in this order:

1. A valid `path` in the review URL.
2. The version manifest's `entryPath`.
3. No selection. The viewer does not guess by opening an arbitrary asset from the manifest.

The Files tab makes every manifest row selectable. Selecting a row updates the preview and the URL's `path` query without changing the selected version. HTML, image, and video entries use their native presentation; every other declared type uses the typed fallback. Browser back and forward restore the previous path. A missing path, a path outside the manifest, or a file that cannot be previewed settles into an explicit fallback state.

### 2.2 Images

An entry whose normalized manifest media type starts with `image/` renders in a native `<img>` element. The file extension does not participate in the decision.

- The image is centered on the existing preview canvas.
- The default fit preserves aspect ratio, shrinks an oversized image to the available space, and does not enlarge a smaller image past its natural dimensions.
- The existing focus control removes the artifact list and inspector so the image can use the application viewport. This is the full artifact-viewing mode; it is not a second viewer.
- SVG is loaded only as an image resource. Its markup is never inserted into the application DOM.
- Animated formats follow browser behavior. Artifact Server adds no animation controls in this slice.

The first conformance fixtures are PNG, JPEG, WebP, GIF, and SVG. Other `image/*` entries may render when the active browser supports them. A browser decode failure uses the fallback in section 5 rather than claiming that the file is corrupt.

### 2.3 Video

An entry whose normalized manifest media type starts with `video/` renders in a native `<video controls playsInline preload="metadata">` element.

- Video never autoplays.
- The video is contained within the canvas and preserves its aspect ratio.
- Browser-native controls provide play, pause, seeking, volume, playback speed where supported, picture-in-picture where supported, and video full screen where supported.
- The focus control remains available around the native player.
- No poster is generated. A publisher-provided poster is not discovered automatically in this slice.
- The server supports single byte ranges, `If-Range`, and strong `ETag` validation so the browser can read metadata and seek without downloading the complete file first.

The conformance video fixture uses a browser-decodable WebM file. MP4, WebM, Ogg, and other containers or codecs work only when the active browser can decode them. Artifact Server does not claim codec support beyond the browser.

### 2.4 Identity and controls

The preview header continues to show the artifact name, exact version number, access setting, and `Open version` action. When a non-entry file is selected, it also shows the selected manifest path. The Files tab remains the detailed place for media type, byte size, and fingerprint.

`Open version` keeps its existing meaning: open the version through a content session on the version-scoped content origin. It is not a preview bypass and does not change which version is selected in Artifact Server.

## 3. Media classification

The normalized media type is the lowercase essence of the manifest entry's `mediaType`, with parameters removed. For example, `IMAGE/PNG; charset=binary` normalizes to `image/png`.

- `image/*` selects the image presenter.
- `video/*` selects the video presenter.
- `text/html` keeps the existing credential-free HTML review frame.
- Every other type uses the fallback in section 5.

Artifact Server never sniffs bytes or trusts a filename extension to promote a file into an inline preview. A publisher that labels arbitrary bytes as `image/*` or `video/*` can make the browser attempt a decode, but cannot turn those bytes into an application-origin document.

## 4. Authenticated media delivery

### 4.1 Why this is a separate route

The existing authenticated version-file route is a download and `fetch()` boundary. It deliberately answers with `application/octet-stream`, `Content-Disposition: attachment`, and `nosniff` so a signed-in browser cannot navigate to untrusted artifact bytes as an application-origin document (`CMT-013`). An `<img>` or `<video>` pointed at that route therefore cannot provide a reliable typed preview.

The content-session route is also the wrong primitive for an embedded private preview. It is designed for top-level navigation to a version-scoped origin and uses a host-only, `SameSite=Strict` content cookie. Image and video previews must not depend on third-party cookie behavior.

The viewer therefore adds one authenticated, media-only application-origin route:

| Method and path | Query | Result |
| --- | --- | --- |
| `GET /api/v1/artifacts/:artifactId/versions/:versionId/media` | `?projectId=<project>&path=<manifest path>` | Exact immutable bytes for an eligible native image or video subresource request. |
| `HEAD /api/v1/artifacts/:artifactId/versions/:versionId/media` | Same | The same metadata and authorization with no body. |

This route reuses `requireArtifactRead`, manifest-only path resolution, immutable blob verification, strong `ETag`, `If-None-Match`, `If-Range`, and single-range behavior from the existing version-file delivery code. It adds no storage, token, cookie, content-origin, or public-link concept.

### 4.2 Request boundary

A body-bearing `GET` succeeds only when all of these conditions hold:

1. The current application session may read the artifact and exact version.
2. `projectId` matches the artifact's project and `path` exactly matches one manifest entry.
3. The normalized manifest media type is `image/*` or `video/*`.
4. Fetch Metadata reports `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: no-cors`.
5. `Sec-Fetch-Dest` is `image` for an image entry or `video` for a video entry.

Missing Fetch Metadata, `document`, `iframe`, `frame`, `object`, `embed`, `empty`, a cross-site request, or a media-type/destination mismatch is refused before any blob body opens. The stable error code is `MEDIA_PREVIEW_CONTEXT_REQUIRED` for an invalid request context and `MEDIA_PREVIEW_TYPE_UNSUPPORTED` for an ineligible manifest media type. `HEAD` may use `Sec-Fetch-Dest: empty`, but it still requires a same-origin authenticated request and returns no bytes.

The [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/) defines native image requests as `image` plus `no-cors`, top-level navigation as `document` plus `navigate`, and the `Sec-` headers as forbidden to page JavaScript. Artifact Server uses that distinction and fails closed. A browser that omits Fetch Metadata can still use `Open version` but cannot use the inline media route. Supporting that browser is not a reason to relax this boundary.

An invalid request context answers `403`. An ineligible manifest media type answers `415`. Existing authentication, project mismatch, version, and manifest-path failures keep their normal status and error shapes.

This request contract is part of the security boundary, not a convenience check. Hostile tests must prove that pasting the media URL into a tab does not render the response and that an unrelated site cannot embed it.

### 4.3 Response contract

A successful response uses the manifest media type and includes:

- `Content-Type: <manifest mediaType>`
- `Content-Disposition: inline` with a safely encoded filename
- `X-Content-Type-Options: nosniff`
- `Cross-Origin-Resource-Policy: same-origin`
- `Content-Security-Policy: sandbox; default-src 'none'`
- `Accept-Ranges: bytes`
- `ETag: "<entry sha256>"`
- `Cache-Control: private, max-age=31536000, immutable`
- `Vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site`

Full responses answer `200`, valid single ranges answer `206`, unsatisfiable ranges answer `416`, and matching conditional requests answer `304`. Blob size and hash-backed identity checks remain the same as ordinary immutable delivery.

The original version-file route remains download-only and unchanged. The media route never serves HTML, XML outside `image/svg+xml`, scripts, styles, PDFs, office documents, archives, or unknown types. It never accepts a URL or a storage key.

## 5. Loading, failure, and recovery

The preview must always settle. It must not leave the current permanent "Loading preview" card in the canvas.

| State | Presentation | Recovery |
| --- | --- | --- |
| Loading | A bounded loading state names the selected path. Existing content remains only until the new selection is confirmed. | None. |
| Ready image | The decoded image replaces loading. | Focus view or `Open version`. |
| Ready video | Native controls appear after metadata can load. | Play, seek, focus view, or `Open version`. |
| Browser cannot decode | A typed fallback says that this browser cannot preview the media type. It does not call the artifact corrupt. | `Open version` and `Download file`. |
| Authentication expired | The normal session-expired response appears. | Sign in, then retry the same tuple. |
| Version or path missing | The preview says that the selected immutable file no longer resolves in the requested project context. | Return to the manifest entry path. |
| Delivery or range error | The preview names a delivery failure and stops retrying automatically. | Explicit retry, `Open version`, or `Download file`. |

Changing the artifact, version, or path invalidates the previous load immediately. Late `load`, `loadedmetadata`, `error`, or range responses from an earlier selection cannot replace the current preview. The client removes obsolete media sources so abandoned video requests and decoder work can stop.

## 6. Accessibility

- An image uses the artifact name and selected filename as its fallback accessible name. The UI does not invent a semantic description of visual content.
- The video uses native controls, has an accessible label naming the artifact and file, and never autoplays.
- Loading uses a polite status announcement. A terminal preview failure uses an alert announcement once.
- Focus view retains a visible way to restore the Artifact Server controls.
- Browser zoom remains available. The viewer does not intercept standard browser or native media shortcuts.
- Captions or transcripts appear only when the published media supplies a browser-usable track through a future explicit manifest contract. This slice does not infer sidecar files or generate captions.

## 7. Performance and deployment behavior

- Images use the native resource URL directly. They are not converted to base64 or copied into a JavaScript string.
- Video uses the native resource URL directly with `preload="metadata"`. It is not fetched into one in-memory `Blob` before playback.
- Range reads stream from the existing blob adapter, so local disk, SQLite-backed application state, S3-compatible object storage, and Cloudflare storage keep the same byte path used by ordinary content delivery.
- The route and UI behave the same on local, single-server, Kubernetes, Cloudflare, AWS, and GCP deployments.
- The development proxy must preserve Fetch Metadata and Range request headers. Production reverse proxies must preserve `Range`, `If-Range`, and conditional headers and must not rewrite the response media type.

## 8. Comments and editing

Image and video previews are read-only in this slice. Existing whole-file comments remain available from the Comments surface. The preview does not add image coordinates, video timecodes, drawing tools, trimming, rotation, metadata editing, or replacement uploads.

## 9. Non-goals

- Server-side media probing, transcoding, compression, resizing, or repair.
- Adaptive streaming manifests, segment generation, or a media CDN.
- Generated thumbnails, contact sheets, posters, waveforms, or galleries.
- A custom image decoder, video player, codec polyfill, or playback analytics.
- EXIF inspection, color-profile controls, image comparison, or frame comparison.
- Image-region comments, video-time comments, captions generation, or transcription.
- Audio, PDF, office-document, archive, Markdown, or source-code preview work.
- Autoplay or background playback.

## 10. Conformance requirements

All five requirements have local normal and hostile evidence and are `behavior_verified`. They remain short of `verified` until the same contract has passing evidence for every deployment named in the ledger.

| ID | Contract |
| --- | --- |
| `PRV-001` | The review interface presents an exact-version image with browser-native decoding, contained layout, focus viewing, and no DOM insertion for SVG. |
| `PRV-002` | The review interface presents an exact-version video with native controls, no autoplay, metadata-only preload, and working ranged seeking. |
| `PRV-003` | Authenticated media delivery is same-origin, media-destination-only, correctly typed, range-capable, and cannot become an application-origin document. |
| `PRV-004` | Manifest file selection is URL-addressable, version-pinned, back/forward aware, and protected from stale preview responses. |
| `PRV-005` | Unsupported types, codecs, corrupt media, and delivery failures settle into an honest typed fallback without sniffing, conversion, or an infinite loading state. |

## 11. Implementation order

1. Add the media route by extracting shared immutable byte and range delivery from the existing version-file handler. Prove the Fetch Metadata boundary before rendering anything in the review interface.
2. Add path selection and image presentation, including SVG hostile tests and the focus layout.
3. Add native video presentation and prove metadata-only loading, range seeking, selection cleanup, and unsupported-codec recovery.
4. Add browser tests for URL restoration, late-response guards, authentication expiry, and terminal fallbacks.
5. Run `pnpm smoke` because HTTP delivery and range behavior changed, then run `pnpm verify:iteration`. Keep every `PRV` requirement unverified until normal and hostile evidence exists for every applicable deployment.
