"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { Role } from "@/config/roles";
import { MEMBER_ROLES, ROLE_LABELS } from "@/lib/validators/members";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { changeMemberRoleAction } from "./actions";

/**
 * Inline role picker for one member row. Changing the selection fires the role
 * change immediately; on failure (e.g. the server's last-owner guard) it reverts
 * to the previous value and shows the reason. `disabled` covers cases the UI
 * forbids up front — your own row, or the tenant's last owner — while the server
 * stays the real boundary.
 */
export function MemberRoleSelect({
  userId,
  role,
  disabled = false,
  disabledReason,
}: {
  userId: string;
  role: Role;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState<Role>(role);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function applyRole(next: Role) {
    if (next === value) return;
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const result = await changeMemberRoleAction(userId, next);
      if (result.ok) {
        router.refresh();
        return;
      }
      // Revert the optimistic selection and surface why it was refused.
      setValue(previous);
      setError(result.formError ?? result.fieldErrors?.role ?? null);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Select
          value={value}
          onValueChange={(next) => {
            if (next) applyRole(next);
          }}
          disabled={disabled || pending}
        >
          <SelectTrigger
            aria-label="Change role"
            title={disabled ? disabledReason : undefined}
            className="w-28"
          >
            <SelectValue>{(v) => ROLE_LABELS[v as Role]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MEMBER_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {pending ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
