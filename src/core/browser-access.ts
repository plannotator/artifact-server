/** Browser access modes selected by an Artifact Server deployment entrypoint. */
export const browserAccessModes = {
  localOwner: "local_owner",
  privateTeam: "private_team",
} as const;

/** Interactive login mechanisms disclosed to the management application. */
export const browserLoginKinds = {
  localOwner: "local_owner",
  oidc: "oidc",
  workOs: "workos",
} as const;

/**
 * Browser authentication policy fixed by the deployment composition root.
 *
 * The discriminated union prevents a local deployment from advertising a
 * remote provider and prevents a team deployment from enabling local-owner
 * access accidentally.
 */
export type BrowserAccess =
  | {
    readonly loginKind: typeof browserLoginKinds.localOwner;
    readonly mode: typeof browserAccessModes.localOwner;
  }
  | {
    readonly loginKind:
      | typeof browserLoginKinds.oidc
      | typeof browserLoginKinds.workOs;
    readonly mode: typeof browserAccessModes.privateTeam;
  };

/** The browser access policy for a single-developer, loopback-only process. */
export const localOwnerBrowserAccess: BrowserAccess = {
  loginKind: browserLoginKinds.localOwner,
  mode: browserAccessModes.localOwner,
};

/** Create the browser access policy for a remotely deployed private team. */
export function privateTeamBrowserAccess(
  loginKind:
    | typeof browserLoginKinds.oidc
    | typeof browserLoginKinds.workOs,
): Extract<BrowserAccess, {readonly mode: "private_team"}> {
  return {loginKind, mode: browserAccessModes.privateTeam};
}
