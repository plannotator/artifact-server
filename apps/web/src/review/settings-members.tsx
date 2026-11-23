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
import { settingsText } from "@/i18n/messages/settings";
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
      setError(caught instanceof Error ? caught : new Error(settingsText.members.listFailed));
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
      setError(caught instanceof Error ? caught : new Error(settingsText.members.admitFailed));
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
      setError(caught instanceof Error ? caught : new Error(settingsText.members.deactivateFailed));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <Dialog>
            <DialogTrigger render={<Button type="button" />}>{settingsText.members.admitMember}</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{settingsText.members.admitMember}</DialogTitle>
                <DialogDescription>
                  {settingsText.members.admitDescription}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="member-name">{settingsText.members.displayName}</Label>
                  <Input
                    id="member-name"
                    maxLength={200}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    value={displayName}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="member-email">{settingsText.members.email}</Label>
                  <Input
                    id="member-email"
                    maxLength={320}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    type="email"
                    value={email}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="member-role">{settingsText.members.role}</Label>
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
                    <NativeSelectOption value="member">{settingsText.members.roleOptionMember}</NativeSelectOption>
                    <NativeSelectOption value="administrator">
                      {settingsText.members.roleOptionAdministrator}
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
                  {pending ? settingsText.members.admitting : settingsText.members.admitMember}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        description={settingsText.members.description}
        eyebrow={settingsText.members.eyebrow}
        title={settingsText.members.title}
      />

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}
      {loading && members.length === 0
        ? (
          <StatePanel
            description={settingsText.members.loadingDescription}
            title={settingsText.members.loadingTitle}
          />
        )
        : (
          <div className="overflow-x-auto">
            <table className="as-stack-table w-full min-w-3xl text-left text-sm">
              <thead className="border-b text-sm text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">{settingsText.members.columnMember}</th>
                  <th className="px-4 py-3 font-medium">{settingsText.members.columnRole}</th>
                  <th className="px-4 py-3 font-medium">{settingsText.members.columnStatus}</th>
                  <th className="px-4 py-3 font-medium">{settingsText.members.columnAdmitted}</th>
                  <th className="px-4 py-3 text-right font-medium">{settingsText.members.columnActions}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr className="border-b last:border-b-0" key={member.id}>
                    <td className="px-4 py-4">
                      <p className="font-heading font-semibold">{member.displayName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{member.email}</p>
                    </td>
                    <td className="px-4 py-4 capitalize">{settingsText.members.roleValue[member.role]}</td>
                    <td className="px-4 py-4">
                      <StatusBadge tone={member.status === "active" ? "primary" : "neutral"}>
                        {settingsText.members.statusValue[member.status]}
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
                              {settingsText.members.deactivate}
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>{settingsText.members.deactivateTitle}</DialogTitle>
                                <DialogDescription>
                                  {settingsText.members.deactivateDescription(member.displayName)}
                                </DialogDescription>
                              </DialogHeader>
                              <DialogFooter>
                                <Button
                                  disabled={pending}
                                  onClick={() => void deactivate(member.id)}
                                  type="button"
                                  variant="destructive"
                                >
                                  {pending ? settingsText.members.deactivating : settingsText.members.deactivateMember}
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
