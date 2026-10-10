# Review mode

HTML artifacts have two Review modes. **Annotate** captures clicks for comments. **Interact** lets clicks reach the artifact so people can use a prototype. The existing mode toggle and Escape shortcut remain available.

Every artifact has a default `reviewMode`: `annotate` or `interact`. Existing artifacts and new artifacts without an explicit choice default to `annotate`. The default belongs to the artifact and remains through publication and restore of immutable versions.

## Choose a default when publishing

With the CLI:

```sh
artifactserver publish ./dist --name "Product prototype" --review-mode interact
```

`--review-mode` applies only to a new artifact. It cannot be combined with `--artifact` when publishing a new version.

With MCP, include `reviewMode` in the `new_artifact` target of `artifact_commit_upload`:

```json
{
  "kind": "new_artifact",
  "name": "Product prototype",
  "reviewMode": "interact"
}
```

The HTTP upload-commit request accepts the same field in `target`. A `new_version` target does not accept it.

## Change an existing default

Read the artifact to obtain its current version ID. Call `artifact_set_review_mode` with `artifactId`, `reviewMode`, `expectedCurrentVersionId`, a new `idempotencyKey`, and, when needed, `projectId`.

The HTTP equivalent is:

```http
PATCH /api/v1/artifacts/art_example/review-mode?projectId=prj_example
Idempotency-Key: example-review-mode-change
Content-Type: application/json

{"reviewMode":"interact","expectedCurrentVersionId":"ver_example"}
```

The project query is optional. The operation requires artifact-management permission and checks that the current version still matches `expectedCurrentVersionId`. Reuse the idempotency key only for an exact retry. Changing the default records a `change_review_mode` action; it creates no version and changes no stored file bytes or version IDs.

## Override a mode in a link

Add `mode=interact` or `mode=annotate` to a Review URL. For example, add `&mode=interact` to the returned `links.review` URL, which already has query parameters.

The initial mode is chosen in this order: a valid link override, the artifact's stored default, then `annotate`. An invalid mode value is ignored. Review navigation preserves a valid override, and browser back and forward restore it. Changing the mode with the toggle or Escape does not change the stored default. Refreshing Review data or changing the selected version does not reset a manual choice.

Mode selection changes HTML Review interaction only. It does not change artifact access, sandboxing, raw-content links, or the presentation of image and video previews.
