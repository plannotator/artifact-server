/**
 * Boundary declaration for `@plannotator/ui/utils/skillCatalog` (0.30.0,
 * utils/skillCatalog.ts:55-70). The composer's `/`-trigger autocomplete
 * otherwise calls `GET /api/skills`, a Plannotator route this server does not
 * serve and the review frame's `connect-src 'none'` forbids; the frame
 * installs an empty transport so the request is never attempted.
 */
export interface SkillCatalogEntry {
  name: string;
  root: "claude" | "codex" | "universal";
  description?: string | undefined;
  humanOnly: boolean;
  dir?: string | undefined;
}

export type SkillCatalogTransport = () => Promise<SkillCatalogEntry[]>;

export declare function setSkillCatalogTransport(
  transport: SkillCatalogTransport,
): void;
