# Helm install instructions reference a private container image

## Summary

The Helm chart at `packaging/helm/artifact-server` and its README default to
pulling `ghcr.io/plannotator/artifact-server`, but that image appears to be
private. Following the documented install steps as written results in
`ImagePullBackoff` for anyone outside the project's GitHub organization.

## Evidence

1. **No public package listing.** `github.com/plannotator/artifact-server/pkgs/container/artifact-server`
   returns `404`, and so does the org-level packages page. A public GHCR
   package normally has a browsable page at that URL.

2. **GHCR refuses to issue even an anonymous pull token.**

   ```sh
   curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:plannotator/artifact-server:pull"
   # {"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}
   ```

   Public GHCR images issue an anonymous token for this scope without
   credentials. This request fails before a manifest is even attempted,
   which is the standard signature of a private image (as opposed to, say,
   a typo'd repository name, which GHCR reports differently).

3. **The release workflow calls it private.** In
   `.github/workflows/release.yml`, the step that logs in before pushing the
   image is literally named:

   ```yaml
   - name: Sign in to private GHCR for image publication
   ```

## Where the docs go wrong

`packaging/helm/artifact-server/values.yaml` ships:

```yaml
image:
  repository: ghcr.io/plannotator/artifact-server
  tag: "0.1.0"
imagePullSecrets: []
```

and the chart's `README.md` "Required setup" section walks through creating a
namespace `Secret` for the API token and Postgres URL, and shows a sample
values file with:

```yaml
image:
  repository: ghcr.io/plannotator/artifact-server
  digest: sha256:replace_with_release_digest
```

Nowhere in that README, or in `docs/deployment.md`, is there any mention of:

- `imagePullSecrets`,
- creating a `docker-registry` Secret for GHCR auth, or
- how an external installer is meant to obtain pull access to the image at
  all.

## Steps to reproduce

1. Follow `packaging/helm/artifact-server/README.md` "Required setup" and
   "Install with Helm 4" sections as written, without adding an
   `imagePullSecrets` entry (the docs never ask for one).
2. `helm upgrade --install artifact-server ...`
3. Pods land in `ImagePullBackoff` / `ErrImagePull` because the referenced
   image cannot be pulled without registry credentials that the
   documentation never describes how to obtain.

## Expected behavior

One of:

- The image referenced by the chart is actually public, and the pull
  failure has some other cause (in which case this report is wrong — happy
  to be corrected), **or**
- The image is intentionally private, and the docs say so explicitly and
  explain how an external installer gets pull access (e.g., a documented
  process for requesting access, an `imagePullSecrets` example, or a
  pointer to a genuinely public mirror/tag).

## Suggested fix

- If a public image is intended: publish `ghcr.io/plannotator/artifact-server`
  as a public GHCR package (GHCR packages can be made public independently
  of the source repo's visibility) and confirm with an anonymous
  `docker pull`.
- If the image must remain private: add an `imagePullSecrets` section to the
  chart README's "Required setup" (with a sample `kubectl create secret
  docker-registry` command) and a note in `docs/deployment.md` on how
  self-hosters get access to the image.

## Environment

- Repository: `plannotator/artifact-server`
- Chart: `packaging/helm/artifact-server`, `Chart.yaml` version `0.1.1`,
  `appVersion` `0.1.0`
- Checked: 2026-09-18, unauthenticated (no GitHub/GHCR credentials)
