import {useEffect, useState} from "react";

import { api, type InstallationMember } from "@/api/client";
import { ErrorPanel, PageHeader, StatePanel, StatusBadge } from "@/components/product";
import { Button } from "@/components/ui/button";
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { formatTimestamp } from "@/lib/presentation";

type MemberRole = "administrator" | "member";

/** Administrator-only installation member lifecycle surface. */
export function MembersScreen({viewerId}: {viewerId: string}) {
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setMembers(await api.members());
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const admit = async () => {
    setPending(true);
    setError(null);
    try {
      await api.admitMember(displayName, email, role);
      setDisplayName("");
      setEmail("");
      setRole("member");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member admission failed."));
    } finally {
      setPending(false);
    }
  };

  const deactivate = async (memberId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.deactivateMember(memberId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member deactivation failed."));
    } finally {
      setPending(false);
    }
  };

  const activate = async (memberId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.activateMember(memberId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member activation failed."));
    } finally {
      setPending(false);
    }
  };

  const rename = async (memberId: string, name: string) => {
    setPending(true);
    setError(null);
    try {
      await api.updateMemberDisplayName(memberId, name.trim());
      setEditingId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Member rename failed."));
    } finally {
      setPending(false);
    }
  };

  const changeRole = async (memberId: string, nextRole: MemberRole) => {
    setPending(true);
    setError(null);
    try {
      await api.setMemberRole(memberId, nextRole);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Role change failed."));
    } finally {
      setPending(false);
    }
  };

  const activeAdministrators = members.filter(
    (member) => member.status === "active" && member.role === "administrator",
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <Dialog>
            <DialogTrigger render={<Button type="button" />}>Admit member</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Admit member</DialogTitle>
                <DialogDescription>
                  Admit one person to this installation. Every active member can manage artifacts
                  in every project.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="member-name">Display name</Label>
                  <Input
                    id="member-name"
                    maxLength={200}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    value={displayName}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="member-email">Email</Label>
                  <Input
                    id="member-email"
                    maxLength={320}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    type="email"
                    value={email}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="member-role">Role</Label>
                  <NativeSelect
                    className="w-full"
                    id="member-role"
                    onChange={(event) => {
                      setRole(event.currentTarget.value === "administrator"
                        ? "administrator"
                        : "member");
                    }}
                    value={role}
                  >
                    <NativeSelectOption value="member">Member</NativeSelectOption>
                    <NativeSelectOption value="administrator">
                      Administrator
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
              </div>
              <DialogFooter>
                <Button
                  disabled={pending || displayName.trim() === "" || email.trim() === ""}
                  onClick={() => void admit()}
                  type="button"
                >
                  {pending ? "Admitting…" : "Admit member"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        description="One installation has one closed member group. There is no public sign-up or project-specific membership."
        eyebrow="Administration"
        title="Members"
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}
      {loading && members.length === 0
        ? (
          <StatePanel
            description="Loading installation members."
            title="Loading members"
          />
        )
        : (
          <div className="overflow-x-auto border">
            <table className="w-full min-w-3xl text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs tracking-widest text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3 font-semibold">Member</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Admitted</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.id === viewerId;
                  const isLastActiveAdministrator = member.role === "administrator"
                    && member.status === "active"
                    && activeAdministrators <= 1;
                  return (
                    <tr className="border-b last:border-b-0" key={member.id}>
                      <td className="px-4 py-4">
                        {editingId === member.id
                          ? (
                            <div className="flex items-center gap-2">
                              <Input
                                maxLength={200}
                                onChange={(event) => setEditedName(event.currentTarget.value)}
                                value={editedName}
                              />
                              <Button
                                disabled={pending || editedName.trim() === ""}
                                onClick={() => void rename(member.id, editedName)}
                                size="xs"
                                type="button"
                              >
                                Save
                              </Button>
                              <Button
                                onClick={() => setEditingId(null)}
                                size="xs"
                                type="button"
                                variant="ghost"
                              >
                                Cancel
                              </Button>
                            </div>
                          )
                          : (
                            <div className="flex items-center gap-2">
                              <p className="font-heading font-semibold">{member.displayName}</p>
                              {member.status === "active"
                                ? (
                                  <Button
                                    onClick={() => {
                                      setEditingId(member.id);
                                      setEditedName(member.displayName);
                                    }}
                                    size="xs"
                                    type="button"
                                    variant="ghost"
                                  >
                                    Rename
                                  </Button>
                                )
                                : null}
                            </div>
                          )}
                        <p className="mt-1 text-xs text-muted-foreground">{member.email}</p>
                      </td>
                      <td className="px-4 py-4">
                        {member.status === "active" && !isSelf
                          ? (
                            <NativeSelect
                              className="w-40"
                              disabled={pending || isLastActiveAdministrator}
                              onChange={(event) => void changeRole(
                                member.id,
                                event.currentTarget.value === "administrator"
                                  ? "administrator"
                                  : "member",
                              )}
                              value={member.role}
                            >
                              <NativeSelectOption value="member">Member</NativeSelectOption>
                              <NativeSelectOption value="administrator">
                                Administrator
                              </NativeSelectOption>
                            </NativeSelect>
                          )
                          : <span className="capitalize">{member.role}</span>}
                        {isSelf
                          ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Your own role cannot change here.
                            </p>
                          )
                          : null}
                        {isLastActiveAdministrator && !isSelf
                          ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              The installation keeps one active administrator.
                            </p>
                          )
                          : null}
                      </td>
                      <td className="px-4 py-4">
                        <StatusBadge tone={member.status === "active" ? "primary" : "neutral"}>
                          {member.status}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-muted-foreground">
                        {formatTimestamp(member.createdAt)}
                      </td>
                      <td className="px-4 py-4 text-right">
                        {member.status === "inactive"
                          ? (
                            <Button
                              disabled={pending}
                              onClick={() => void activate(member.id)}
                              size="xs"
                              type="button"
                            >
                              {pending ? "Activating…" : "Activate"}
                            </Button>
                          )
                          : (
                            <Dialog>
                              <DialogTrigger
                                render={<Button size="xs" type="button" variant="ghost" />}
                              >
                                Deactivate
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Deactivate member</DialogTitle>
                                  <DialogDescription>
                                    {member.displayName} will lose new browser sessions and API access.
                                    Existing artifact records and attribution remain unchanged.
                                  </DialogDescription>
                                </DialogHeader>
                                <DialogFooter>
                                  <Button
                                    disabled={pending}
                                    onClick={() => void deactivate(member.id)}
                                    type="button"
                                    variant="destructive"
                                  >
                                    {pending ? "Deactivating…" : "Deactivate member"}
                                  </Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
