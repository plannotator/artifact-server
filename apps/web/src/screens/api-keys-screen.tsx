import { useEffect, useState } from "react";

import {
  api,
  type InstallationMember,
  type IssuedApiKey,
  type ManagedApiKey,
  type PrincipalCapability,
} from "@/api/client";
import { ErrorPanel, PageHeader, StatePanel, StatusBadge } from "@/components/product";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTimestamp } from "@/lib/presentation";

const capabilities: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: PrincipalCapability;
}[] = [
  { description: "List and read artifact metadata.", label: "Read artifacts", value: "artifact:read" },
  { description: "Create new artifacts.", label: "Create artifacts", value: "artifact:create" },
  { description: "Publish new immutable versions.", label: "Publish versions", value: "artifact:publish:any" },
  { description: "Restore, change tags and access, or tombstone.", label: "Manage artifacts", value: "artifact:manage:any" },
  { description: "Open account-required artifact content.", label: "Issue content sessions", value: "content-session:issue" },
  { description: "Create, rename, archive, and unarchive projects.", label: "Manage projects", value: "project:manage" },
];

/** Administrator-only managed API key issuance and lifecycle surface. */
export function ApiKeysScreen() {
  const [apiKeys, setApiKeys] = useState<readonly ManagedApiKey[]>([]);
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("");
  const [memberId, setMemberId] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<
    readonly PrincipalCapability[]
  >([]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedKeys, loadedMembers] = await Promise.all([
        api.apiKeys(),
        api.members(),
      ]);
      setApiKeys(loadedKeys);
      setMembers(loadedMembers);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggleCapability = (capability: PrincipalCapability, checked: boolean) => {
    setSelectedCapabilities((current) => checked
      ? [...current, capability]
      : current.filter((candidate) => candidate !== capability));
  };

  const issue = async () => {
    setPending(true);
    setError(null);
    try {
      const expirationDate = new Date(expiration);
      const result = await api.issueApiKey(
        name,
        expirationDate.toISOString(),
        selectedCapabilities,
        memberId === "" ? undefined : memberId,
      );
      setIssued(result);
      setName("");
      setExpiration("");
      setMemberId("");
      setSelectedCapabilities([]);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key issuance failed."));
    } finally {
      setPending(false);
    }
  };

  const rotate = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      setIssued(await api.rotateApiKey(keyId));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key rotation failed."));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.revokeApiKey(keyId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key revocation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <Dialog>
            <DialogTrigger render={<Button type="button" />}>Issue API key</DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>Issue API key</DialogTitle>
                <DialogDescription>
                  The secret appears once. Give the key only the capabilities it needs and choose
                  a future expiration.
                </DialogDescription>
              </DialogHeader>
              <div className="grid max-h-[60svh] gap-5 overflow-y-auto pr-1">
                <div className="grid gap-2">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    maxLength={200}
                    onChange={(event) => setName(event.currentTarget.value)}
                    value={name}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="api-key-expiration">Expires at</Label>
                  <Input
                    id="api-key-expiration"
                    min={new Date().toISOString().slice(0, 16)}
                    onChange={(event) => setExpiration(event.currentTarget.value)}
                    type="datetime-local"
                    value={expiration}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="api-key-owner">Owner</Label>
                  <select
                    className="h-10 rounded-none border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                    id="api-key-owner"
                    onChange={(event) => setMemberId(event.currentTarget.value)}
                    value={memberId}
                  >
                    <option value="">Service principal</option>
                    {members.filter((member) => member.status === "active").map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName} · {member.email}
                      </option>
                    ))}
                  </select>
                </div>
                <fieldset className="grid gap-3">
                  <legend className="text-sm font-medium">Capabilities</legend>
                  {capabilities.map((capability) => {
                    const checked = selectedCapabilities.includes(capability.value);
                    return (
                      <label
                        className="group/field grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 border p-3"
                        key={capability.value}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => toggleCapability(capability.value, next)}
                        />
                        <span>
                          <span className="block text-sm font-medium">{capability.label}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {capability.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </div>
              <DialogFooter>
                <Button
                  disabled={pending
                    || name.trim() === ""
                    || expiration === ""
                    || selectedCapabilities.length === 0}
                  onClick={() => void issue()}
                  type="button"
                >
                  {pending ? "Issuing…" : "Issue API key"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        description="Managed API keys have explicit capabilities, a required expiration, and revocation. Secrets are never shown again."
        eyebrow="Administration"
        title="API keys"
      />

      <SecretDialog issued={issued} onDiscard={() => setIssued(null)} />
      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}
      {loading && apiKeys.length === 0
        ? (
          <StatePanel description="Loading managed API keys." title="Loading API keys" />
        )
        : apiKeys.length === 0
          ? (
            <StatePanel
              description="Issue a scoped key for automation or a compatible self-hosted MCP client."
              title="No managed API keys"
            />
          )
          : (
            <div className="grid border">
              {apiKeys.map((apiKey) => (
                <article className="grid gap-4 border-b p-5 last:border-b-0 lg:grid-cols-[1fr_1.5fr_auto]" key={apiKey.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-heading font-semibold">{apiKey.name}</h2>
                      <StatusBadge tone={apiKey.revokedAt === null ? "primary" : "danger"}>
                        {apiKey.revokedAt === null ? "Active" : "Revoked"}
                      </StatusBadge>
                    </div>
                    <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
                      {apiKey.prefix}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Expires {formatTimestamp(apiKey.expiresAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap content-start gap-x-3 gap-y-2">
                    {apiKey.capabilities.map((capability) => (
                      <StatusBadge key={capability}>{capability}</StatusBadge>
                    ))}
                  </div>
                  {apiKey.revokedAt === null
                    ? (
                      <div className="flex gap-2 lg:justify-end">
                        <Button
                          disabled={pending}
                          onClick={() => void rotate(apiKey.id)}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          Rotate
                        </Button>
                        <Dialog>
                          <DialogTrigger render={<Button size="xs" type="button" variant="ghost" />}>
                            Revoke
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Revoke API key</DialogTitle>
                              <DialogDescription>
                                Requests using {apiKey.name} will stop immediately. Revocation does
                                not remove prior action attribution.
                              </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                              <Button
                                disabled={pending}
                                onClick={() => void revoke(apiKey.id)}
                                type="button"
                                variant="destructive"
                              >
                                {pending ? "Revoking…" : "Revoke API key"}
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      </div>
                    )
                    : null}
                </article>
              ))}
            </div>
          )}
    </div>
  );
}

function SecretDialog({
  issued,
  onDiscard,
}: {
  readonly issued: IssuedApiKey | null;
  readonly onDiscard: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (issued === null) return null;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onDiscard();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy API key now</DialogTitle>
          <DialogDescription>
            This secret is displayed once. Store it in the intended client's secret input or a
            deployment secret manager. Artifact Server cannot show it again.
          </DialogDescription>
        </DialogHeader>
        <code className="max-h-32 overflow-auto border bg-muted p-3 font-mono text-xs break-all">
          {issued.token}
        </code>
        <DialogFooter>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(issued.token).then(() => setCopied(true));
            }}
            type="button"
          >
            {copied ? "Copied" : "Copy API key"}
          </Button>
          <Button onClick={onDiscard} type="button" variant="outline">
            I stored it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
