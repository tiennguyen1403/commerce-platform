import type { Metadata } from "next";
import { requireRole } from "@/server/auth/admin-context";
import { ROLES } from "@/config/roles";
import { membershipService } from "@/server/services/membership.service";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddMemberForm } from "./add-member-form";
import { MemberRoleSelect } from "./member-role-select";
import { RemoveMemberButton } from "./remove-member-button";

export const metadata: Metadata = { title: "Members" };

// Rendered server-side only, so a fixed locale keeps the "Added" column stable.
const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

export default async function MembersPage() {
  // OWNER-only: a member below OWNER is redirected to /admin. This is the
  // security boundary — the hidden nav link is just UX.
  const { tenantId, userId } = await requireRole(ROLES.OWNER);
  const members = await membershipService.listMembers(tenantId);
  const ownerCount = members.filter((m) => m.role === "OWNER").length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="text-muted-foreground text-sm">
          Manage who can access this store’s admin, and what they can do.
        </p>
      </div>

      <AddMemberForm />

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const isSelf = m.userId === userId;
              const isLastOwner = m.role === "OWNER" && ownerCount === 1;
              // You can't change or remove your own membership from here (avoids
              // a self-lockout foot-gun), nor touch the tenant's last owner.
              const roleDisabledReason = isSelf
                ? "You can’t change your own role."
                : isLastOwner
                  ? "A store must keep at least one owner."
                  : undefined;
              const removeDisabledReason = isSelf
                ? "You can’t remove yourself."
                : isLastOwner
                  ? "A store must keep at least one owner."
                  : undefined;

              return (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span>
                        {m.user.name}
                        {isSelf ? (
                          <span className="text-muted-foreground font-normal">
                            {" "}
                            (You)
                          </span>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {m.user.email}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <MemberRoleSelect
                      userId={m.userId}
                      role={m.role}
                      disabled={Boolean(roleDisabledReason)}
                      disabledReason={roleDisabledReason}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {dateFormatter.format(m.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RemoveMemberButton
                      userId={m.userId}
                      memberName={m.user.name}
                      disabled={Boolean(removeDisabledReason)}
                      disabledReason={removeDisabledReason}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
