import { useEffect, useState } from "react";

import { api, type ArtifactPage, type Project } from "@/api/client";
import { ErrorPanel, PageHeader, StatePanel, StatusBadge } from "@/components/product";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accessSettingLabel, formatTimestamp } from "@/lib/presentation";

/** Bounded artifact list for one exact project context. */
export function ArtifactsScreen({ project }: { readonly project: Project }) {
  const [page, setPage] = useState<ArtifactPage | null>(null);
  const [items, setItems] = useState<ArtifactPage["artifacts"]>([]);
  const [tag, setTag] = useState("");
  const [appliedTag, setAppliedTag] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = async (cursor: string | null, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await api.artifacts(project.id, cursor, appliedTag);
      setPage(loaded);
      setItems((current) => replace ? loaded.artifacts : [...current, ...loaded.artifacts]);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Artifact list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(null, true);
  }, [project.id, appliedTag]);

  const openAccountRequired = async (artifactId: string) => {
    const popup = window.open("about:blank", "_blank");
    setOpeningId(artifactId);
    setError(null);
    try {
      const issued = await api.contentSession(project.id, artifactId);
      if (popup === null) {
        window.location.assign(issued.bootstrapUrl);
      } else {
        popup.opener = null;
        popup.location.replace(issued.bootstrapUrl);
      }
    } catch (caught) {
      popup?.close();
      setError(caught instanceof Error ? caught : new Error("Artifact opening failed."));
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        description={project.archivedAt === null
          ? "Browse active artifacts in this project. Publication stays in the CLI and Agent Skill."
          : "This project is archived. Existing artifacts and versions remain available, but new artifacts and versions are blocked."}
        eyebrow="Project"
        title={project.name}
      />

      {project.archivedAt === null ? null : (
        <div className="border border-primary/30 bg-primary/5 p-4 text-sm leading-6">
          <strong>Archived project.</strong> Existing artifacts, links, comparisons, and
          immutable versions are preserved.
        </div>
      )}

      <form
        className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedTag(tag.trim());
        }}
      >
        <div className="grid flex-1 gap-2">
          <Label htmlFor="artifact-tag-filter">Exact tag</Label>
          <Input
            id="artifact-tag-filter"
            maxLength={40}
            onChange={(event) => setTag(event.currentTarget.value)}
            placeholder="prototype"
            value={tag}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="outline">Filter</Button>
          {appliedTag === ""
            ? null
            : (
              <Button
                onClick={() => {
                  setTag("");
                  setAppliedTag("");
                }}
                type="button"
                variant="ghost"
              >
                Clear
              </Button>
            )}
        </div>
      </form>

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load(null, true)} />}
      {loading && items.length === 0
        ? (
          <StatePanel
            description="Loading the selected project's active artifacts."
            title="Loading artifacts"
          />
        )
        : items.length === 0
          ? (
            <StatePanel
              action={(
                <div className="grid gap-2 text-sm">
                  <code className="border bg-muted px-3 py-2 font-mono">
                    artifactserver publish &lt;file-or-directory&gt; --project {project.id}
                  </code>
                  <p className="text-muted-foreground">
                    Agents can also use the <strong>publish-artifact</strong> Agent Skill.
                  </p>
                </div>
              )}
              description={appliedTag === ""
                ? "Publish a finished file or client-side site through the existing CLI or Agent Skill."
                : `No active artifact has the exact normalized tag “${appliedTag}”.`}
              title={appliedTag === "" ? "No artifacts yet" : "No matching artifacts"}
            />
          )
          : (
            <div className="overflow-x-auto border">
              <table className="w-full min-w-3xl border-collapse text-left text-sm">
                <thead className="border-b bg-muted/50 text-xs tracking-widest text-muted-foreground uppercase">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Artifact</th>
                    <th className="px-4 py-3 font-semibold">Access</th>
                    <th className="px-4 py-3 font-semibold">Current version</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                    <th className="px-4 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(({ artifact, links }) => (
                    <tr className="border-b last:border-b-0" key={artifact.id}>
                      <td className="max-w-sm px-4 py-4 align-top">
                        <a
                          className="font-heading font-semibold hover:underline"
                          href={`/projects/${encodeURIComponent(project.id)}/artifacts/${encodeURIComponent(artifact.id)}`}
                        >
                          {artifact.name}
                        </a>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {artifact.tags.length === 0
                            ? <span className="text-xs text-muted-foreground">No tags</span>
                            : artifact.tags.map((artifactTag) => (
                              <StatusBadge key={artifactTag}>{artifactTag}</StatusBadge>
                            ))}
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <StatusBadge tone={artifact.accessSetting === "public_link" ? "primary" : "neutral"}>
                          {accessSettingLabel(artifact.accessSetting)}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-4 font-mono text-xs align-top">
                        {artifact.currentVersionId}
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-muted-foreground align-top">
                        {formatTimestamp(artifact.createdAt)}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="flex justify-end gap-2">
                          {artifact.accessSetting === "public_link"
                            ? (
                              <Button
                                render={<a href={links.artifact} rel="noreferrer" target="_blank" />}
                                size="xs"
                                variant="outline"
                              >
                                Open artifact
                              </Button>
                            )
                            : (
                              <Button
                                disabled={openingId === artifact.id}
                                onClick={() => void openAccountRequired(artifact.id)}
                                size="xs"
                                type="button"
                                variant="outline"
                              >
                                {openingId === artifact.id ? "Opening…" : "Open artifact"}
                              </Button>
                            )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

      {page?.nextCursor === null || page === null
        ? null
        : (
          <div>
            <Button
              disabled={loading}
              onClick={() => void load(page.nextCursor, false)}
              type="button"
              variant="outline"
            >
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
    </div>
  );
}
