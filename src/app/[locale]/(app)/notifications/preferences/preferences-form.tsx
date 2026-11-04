"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { savePreferences } from "@/modules/notifications/actions";
import { FormMessage } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type Row = { type: string; label: string; mandatory: boolean; inApp: boolean; email: boolean };

export function PreferencesForm({ rows }: { rows: Row[] }) {
  const t = useTranslations("notifications");
  const tc = useTranslations("common");
  const [state, action] = useActionState(savePreferences, null);
  return (
    <form action={action}>
      <Table>
        <thead>
          <tr>
            <Th>{t("type")}</Th>
            <Th className="w-32 text-center">{t("inApp")}</Th>
            <Th className="w-32 text-center">{t("email")}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <Tr key={r.type}>
              <Td>
                {r.label} {r.mandatory && <Badge tone="amber" className="ms-2">{t("mandatory")}</Badge>}
              </Td>
              {(["inApp", "email"] as const).map((ch) => (
                <Td key={ch} className="text-center">
                  <input
                    type="checkbox"
                    name={`${r.type}:${ch}`}
                    defaultChecked={r[ch]}
                    disabled={r.mandatory}
                    className="size-4 rounded border-slate-300 text-brand-700"
                  />
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
      <div className="flex items-center gap-4 border-t border-slate-100 px-5 py-4">
        <SubmitButton>{tc("save")}</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
