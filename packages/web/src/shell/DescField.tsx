import { useState } from "react";
import { t } from "../i18n/index.ts";
import { Field, Tabs } from "../ui/index.ts";
import { Markdown } from "./Markdown.tsx";

export type DescTab = "write" | "preview";

/**
 * A task description being written (UI-29): a textarea, and a preview tab that renders the draft
 * with the panel's safe Markdown. Only the tab changes: the draft stays in the parent's state, so
 * previewing never saves or loses anything.
 */
export function DescField({
  value,
  rows,
  error,
  onChange,
  initialTab = "write",
}: {
  value: string;
  rows: number;
  error: string | undefined;
  onChange: (value: string) => void;
  initialTab?: DescTab;
}) {
  const [tab, setTab] = useState<DescTab>(initialTab);
  return (
    <div className="b-desc">
      <Tabs
        label={t("edit.field.desc")}
        selected={tab}
        onSelect={(id) => setTab(id === "preview" ? "preview" : "write")}
        tabs={[
          {
            id: "write",
            label: t("edit.desc.write"),
            content: (
              <Field
                multiline
                rows={rows}
                label={t("edit.field.desc")}
                hint={t("edit.field.desc.hint")}
                value={value}
                error={error}
                onChange={(e) => onChange(e.target.value)}
              />
            ),
          },
          {
            id: "preview",
            label: t("edit.desc.preview"),
            content: value.trim() ? (
              <Markdown className="a-desc b-desc__preview" text={value} />
            ) : (
              <p className="s-text s-muted">{t("edit.desc.preview.empty")}</p>
            ),
          },
        ]}
      />
    </div>
  );
}
