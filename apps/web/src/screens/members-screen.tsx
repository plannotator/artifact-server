import { useEffect, useState } from "react";

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

/** Administrator-only installation member lifecycle surface. */
export function MembersScreen() {
  const [members, setMembers] = useState<readonly InstallationMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"administrator" | "member">("member");

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
                {members.map((member) => (
                  <tr className="border-b last:border-b-0" key={member.id}>
                    <td className="px-4 py-4">
                      <p className="font-heading font-semibold">{member.displayName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{member.email}</p>
                    </td>
                    <td className="px-4 py-4 capitalize">{member.role}</td>
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
                        ? null
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
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
