"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import type { ActionState } from "@/core/actions";
import { FormMessage } from "./form";
import { SubmitButton } from "./submit-button";
import { cn } from "./cn";

/**
 * A form bound to a server action returning ActionState. Children can be
 * server-rendered fields. Validation errors are listed under the fields.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  className,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  // Submitting through onSubmit (instead of <form action>) keeps what the user
  // typed when validation fails; React would otherwise reset the form.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };
  const errors = state?.fieldErrors ? Object.entries(state.fieldErrors) : [];
  return (
    <form onSubmit={onSubmit} className={cn("space-y-4", className)}>
      {children}
      {errors.length > 0 && (
        <ul className="list-inside list-disc rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
          {errors.map(([field, msg]) => (
            <li key={field}>
              <span className="font-mono">{field}</span>: {msg}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-4">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <FormMessage state={state?.fieldErrors ? null : state} />
      </div>
    </form>
  );
}
