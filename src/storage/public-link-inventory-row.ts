import {z} from "zod";

import type {PublicLinkInventoryPage} from "../application/public-link-administration.js";
import {
  accessSettings,
  routingModes,
  type ArtifactRecord,
} from "../core/model.js";

/** Validates the joined row shape used by public-link inventory queries. */
export const publicLinkInventoryRowSchema = z.object({
  accessSetting: z.enum([
    accessSettings.accountRequired,
    accessSettings.publicLink,
  ]),
  artifactCreatedAt: z.string(),
  artifactDeletedAt: z.string().nullable(),
  artifactId: z.string(),
  artifactName: z.string(),
  contentToken: z.string(),
  currentVersionId: z.string(),
  entryPath: z.string(),
  installationId: z.string(),
  manifestDigest: z.string(),
  projectArchivedAt: z.string().nullable(),
  projectCreatedAt: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: z.enum([routingModes.static, routingModes.spa]),
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: z.coerce.number().int().positive(),
});

/** Projects validated inventory rows onto existing artifact, version, and project views. */
export function publicLinkPageFromRows(
  rows: readonly z.infer<typeof publicLinkInventoryRowSchema>[],
  artifacts: readonly ArtifactRecord[],
  limit: number,
): PublicLinkInventoryPage {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const selectedRows = rows.slice(0, limit);
  const items = selectedRows.map((row) => {
    const artifact = artifactsById.get(row.artifactId);
    if (artifact === undefined) {
      throw new Error("A public-link inventory artifact disappeared during row projection.");
    }
    return {
      artifact,
      currentVersion: {
        artifactId: row.artifactId,
        contentToken: row.contentToken,
        createdAt: row.versionCreatedAt,
        entryPath: row.entryPath,
        id: row.versionId,
        manifestDigest: row.manifestDigest,
        number: row.versionNumber,
        projectId: row.projectId,
        publisherPrincipalId: row.publisherPrincipalId,
        routingMode: row.routingMode,
      },
      project: {
        archivedAt: row.projectArchivedAt,
        createdAt: row.projectCreatedAt,
        id: row.projectId,
        installationId: row.installationId,
        name: row.projectName,
      },
    };
  });
  const lastRow = selectedRows.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && lastRow !== undefined
      ? {createdAt: lastRow.artifactCreatedAt, id: lastRow.artifactId}
      : null,
  };
}
