"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button, type ButtonVariant } from "./button";

export function SubmitButton({
  children,
  variant,
  size,
  pending: pendingProp,
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Pass isPending from useActionState when the form submits via onSubmit. */
  pending?: boolean;
}) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}
