"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserPlus } from "lucide-react";
import { ROLES, type Role } from "@/config/roles";
import {
  addMemberSchema,
  MEMBER_ROLES,
  ROLE_LABELS,
  type MemberFieldErrors,
} from "@/lib/validators/members";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addMemberAction } from "./actions";

type FormErrors = MemberFieldErrors & { form?: string };

/**
 * Adds an existing account to the tenant by email. New sign-ups happen on the
 * sign-in page — an admin request must never create a login (it would overwrite
 * the owner's session), so an unknown email comes back as a field error asking
 * the owner to have them sign up first.
 */
export function AddMemberForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(ROLES.STAFF);
  const [errors, setErrors] = useState<FormErrors>({});
  const [done, setDone] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDone(null);

    const parsed = addMemberSchema.safeParse({ email: email.trim(), role });
    if (!parsed.success) {
      const next: FormErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "email" && !next.email) next.email = issue.message;
        if (key === "role" && !next.role) next.role = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    startTransition(async () => {
      const result = await addMemberAction(parsed.data);
      if (result.ok) {
        setDone(`Added ${parsed.data.email}.`);
        setEmail("");
        setRole(ROLES.STAFF);
        router.refresh();
        return;
      }
      const next: FormErrors = {};
      if (result.formError) next.form = result.formError;
      if (result.fieldErrors) Object.assign(next, result.fieldErrors);
      setErrors(next);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a member</CardTitle>
        <CardDescription>
          Add an existing account by email. They must have signed up already —
          new accounts are created on the sign-in page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
          noValidate
        >
          {errors.form ? (
            <p
              role="alert"
              className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
            >
              {errors.form}
            </p>
          ) : null}
          {done ? (
            <p role="status" className="text-muted-foreground text-sm">
              {done}
            </p>
          ) : null}

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <Field className="sm:flex-1">
              <FieldLabel htmlFor="member-email">Email</FieldLabel>
              <Input
                id="member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(errors.email)}
                placeholder="teammate@example.com"
                autoComplete="off"
              />
              <FieldError
                errors={errors.email ? [{ message: errors.email }] : undefined}
              />
            </Field>

            <Field className="sm:w-40">
              <FieldLabel htmlFor="member-role">Role</FieldLabel>
              <Select
                value={role}
                onValueChange={(next) => {
                  if (next) setRole(next);
                }}
              >
                <SelectTrigger id="member-role" className="w-full">
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
            </Field>

            <Button
              type="submit"
              disabled={pending}
              className="w-full sm:w-auto"
            >
              {pending ? <Loader2 className="animate-spin" /> : <UserPlus />}
              Add member
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
