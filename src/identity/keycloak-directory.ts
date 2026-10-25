import {Effect, Redacted, Schema} from "effect";

import {
  DirectoryUnavailable,
  type DirectoryGroup,
  type DirectoryUser,
  type MemberDirectory,
} from "../application/directory-sync.js";
import {loadOidcAuthorizationServer} from "./oidc-oauth-metadata.js";
import {isLocalOidcIssuer, normalizeOidcEndpoint} from "./oidc-issuer.js";

/** Members requested per admin page; a shorter page is the last one. */
export const keycloakDirectoryPageSize = 100;
/** Refuse a group so large that reading it all is no longer a bounded pass. */
const maximumPagesPerGroup = 1_000;
const requestTimeoutMilliseconds = 10_000;
const realmPathPattern = /^(?<prefix>(?:\/[^/]+)*)\/realms\/(?<realm>[^/]+)$/u;

const tokenResponse = Schema.Struct({access_token: Schema.NonEmptyString});
const groupList = Schema.Array(Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
}));
const userList = Schema.Array(Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  emailVerified: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  firstName: Schema.optionalKey(Schema.String),
  id: Schema.NonEmptyString,
  lastName: Schema.optionalKey(Schema.String),
  username: Schema.String,
}));
const decodeTokenResponse = Schema.decodeUnknownEffect(tokenResponse);
const decodeGroupList = Schema.decodeUnknownEffect(groupList);
const decodeUserList = Schema.decodeUnknownEffect(userList);

/**
 * Derive the Keycloak admin REST base for one realm issuer, or null when the
 * issuer is not `<base>/realms/<realm>`.
 */
export function keycloakAdminBaseUrl(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  const match = realmPathPattern.exec(url.pathname.replace(/\/+$/u, ""));
  const realm = match?.groups?.["realm"];
  if (match === null || realm === undefined || url.search !== "" || url.hash !== "") {
    return null;
  }
  const prefix = match.groups?.["prefix"] ?? "";
  return `${url.origin}${prefix}/admin/realms/${realm}`;
}

export interface KeycloakDirectoryConfig {
  /** Admin REST base, as {@link keycloakAdminBaseUrl} derives it. */
  readonly adminBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly fetch?: typeof globalThis.fetch;
  /** The realm issuer whose discovery document names the token endpoint. */
  readonly issuer: string;
}

/**
 * Read group membership through the Keycloak admin REST API with a
 * client-credentials token. The client needs only realm-management
 * view-users and query-groups.
 */
export class KeycloakDirectory implements MemberDirectory {
  readonly #adminBaseUrl: string;
  readonly #clientId: string;
  readonly #clientSecret: Redacted.Redacted;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;

  constructor(config: KeycloakDirectoryConfig) {
    const allowLocalHttp = isLocalOidcIssuer(config.issuer);
    const adminBaseUrl = normalizeOidcEndpoint(config.adminBaseUrl, allowLocalHttp);
    if (adminBaseUrl === null) {
      throw new Error("The Keycloak admin URL must be an HTTPS URL.");
    }
    this.#adminBaseUrl = adminBaseUrl.replace(/\/+$/u, "");
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    const providerFetch = config.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => providerFetch(input, init);
    this.#issuer = config.issuer;
  }

  readonly listGroups = Effect.fn("KeycloakDirectory.listGroups")(
    function*(this: KeycloakDirectory, names: readonly string[]) {
      const token = yield* this.#accessToken();
      const groups: DirectoryGroup[] = [];
      for (const name of names) {
        const id = yield* this.#groupId(token, name);
        groups.push({name, users: yield* this.#groupMembers(token, name, id)});
      }
      return groups;
    },
  );

  readonly #accessToken = Effect.fn("KeycloakDirectory.accessToken")(
    function*(this: KeycloakDirectory) {
      const tokenEndpoint = yield* Effect.tryPromise({
        try: async () => {
          const server = await loadOidcAuthorizationServer(this.#issuer, {
            fetch: this.#fetch,
          });
          return server.metadata.token_endpoint;
        },
        catch: () => unavailable("The Keycloak discovery document could not be read."),
      });
      const response = yield* this.#request(tokenEndpoint, {
        body: new URLSearchParams({
          client_id: this.#clientId,
          client_secret: Redacted.value(this.#clientSecret),
          grant_type: "client_credentials",
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }, "The Keycloak token request");
      const body = yield* decodeTokenResponse(response).pipe(
        Effect.mapError(() =>
          unavailable("The Keycloak token response carried no access token.")
        ),
      );
      return Redacted.make(body.access_token, {label: "keycloak-directory-token"});
    },
  );

  readonly #groupId = Effect.fn("KeycloakDirectory.groupId")(function*(
    this: KeycloakDirectory,
    token: Redacted.Redacted,
    name: string,
  ) {
    const url = new URL(`${this.#adminBaseUrl}/groups`);
    url.searchParams.set("search", name);
    url.searchParams.set("exact", "true");
    const body = yield* this.#adminGet(token, url, `The Keycloak group ${name}`);
    const groups = yield* decodeGroupList(body).pipe(
      Effect.mapError(() =>
        unavailable(`The Keycloak group search for ${name} returned an invalid list.`)
      ),
    );
    const group = groups.find((candidate) => candidate.name === name);
    if (group === undefined) {
      return yield* unavailable(`The Keycloak group ${name} does not exist.`);
    }
    return group.id;
  });

  readonly #groupMembers = Effect.fn("KeycloakDirectory.groupMembers")(function*(
    this: KeycloakDirectory,
    token: Redacted.Redacted,
    name: string,
    id: string,
  ) {
    const users: DirectoryUser[] = [];
    for (let page = 0; page < maximumPagesPerGroup; page += 1) {
      const url = new URL(
        `${this.#adminBaseUrl}/groups/${encodeURIComponent(id)}/members`,
      );
      url.searchParams.set("first", String(page * keycloakDirectoryPageSize));
      url.searchParams.set("max", String(keycloakDirectoryPageSize));
      url.searchParams.set("briefRepresentation", "true");
      const body = yield* this.#adminGet(
        token,
        url,
        `The Keycloak members of ${name}`,
      );
      const members = yield* decodeUserList(body).pipe(
        Effect.mapError(() =>
          unavailable(`The Keycloak members of ${name} are not a user list.`)
        ),
      );
      for (const member of members) {
        users.push({
          email: member.email ?? null,
          emailVerified: member.emailVerified === true,
          enabled: member.enabled === true,
          firstName: member.firstName ?? null,
          id: member.id,
          lastName: member.lastName ?? null,
          username: member.username,
        });
      }
      if (members.length < keycloakDirectoryPageSize) return users;
    }
    return yield* unavailable(
      `The Keycloak group ${name} has more members than one sync reads.`,
    );
  });

  #adminGet(
    token: Redacted.Redacted,
    url: URL,
    subject: string,
  ): Effect.Effect<Schema.Json, DirectoryUnavailable> {
    return this.#request(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${Redacted.value(token)}`,
      },
      method: "GET",
    }, subject);
  }

  /** One bounded request whose JSON answer is returned only on HTTP 200. */
  #request(
    url: string,
    init: RequestInit,
    subject: string,
  ): Effect.Effect<Schema.Json, DirectoryUnavailable> {
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await this.#fetch(url, {
          ...init,
          // A followed redirect would replay the client secret or the token.
          redirect: "manual",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(requestTimeoutMilliseconds),
          ]),
        });
        if (response.status !== 200) {
          throw new Error(`${subject} returned HTTP ${response.status}.`);
        }
        const body: Schema.Json = await response.json();
        return body;
      },
      catch: (cause) =>
        unavailable(
          cause instanceof Error && cause.message.startsWith(subject)
            ? cause.message
            : `${subject} failed.`,
        ),
    });
  }
}

function unavailable(message: string): DirectoryUnavailable {
  return new DirectoryUnavailable({message});
}
