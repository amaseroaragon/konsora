import { type FormEvent, useState } from "react";
import { type Approval, useDecide } from "../api/approvals.ts";
import { ApiError } from "../api/client.ts";
import { t } from "../i18n/index.ts";
import { Button, Field, useToast } from "../ui/index.ts";
import { approvalInputText, approvalSummary } from "./approval-model.ts";
import { clock } from "./run-model.ts";

/**
 * One pending approval: which tool the agent wants to use and with what input (escaped and
 * truncated), and Allow or Deny (with an optional reason the agent gets back).
 */
export function ApprovalCard({ approval, readOnly }: { approval: Approval; readOnly: boolean }) {
  const decide = useDecide();
  const toast = useToast();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const input = approvalInputText(approval.input);
  const summary = approvalSummary(approval.input);
  const send = (decision: "allow" | "deny", message?: string) =>
    decide.mutate(
      { run: approval.run, id: approval.id, decision, ...(message ? { message } : {}) },
      {
        onSuccess: () =>
          toast.show(
            t(decision === "allow" ? "approval.allowed" : "approval.denied", {
              tool: approval.tool,
            }),
            decision === "allow" ? "success" : "info",
          ),
        onError: (error) => {
          if (error instanceof ApiError && error.unauthorized) return;
          toast.show(
            t(
              error instanceof ApiError && (error.code === "resolved" || error.status === 404)
                ? "approval.gone"
                : "approval.error",
            ),
            "error",
          );
        },
      },
    );
  const submitDeny = (event: FormEvent) => {
    event.preventDefault();
    send("deny", reason.trim() || undefined);
  };
  return (
    <article
      className="a-callout a-callout--warn a-stack b-approval"
      aria-label={t("approval.label", { tool: approval.tool, id: approval.task })}
    >
      <p className="a-callout__text">
        <b>{t("approval.asks", { id: approval.task })}</b>{" "}
        <span className="k-mono">{approval.tool}</span>
        {summary && (
          <>
            {" · "}
            <span className="k-mono">{summary}</span>
          </>
        )}{" "}
        <span className="s-muted">{clock(approval.requested_at)}</span>
      </p>
      <details className="b-approval__input">
        <summary>{t("approval.input")}</summary>
        <pre className="k-mono">
          {input.text}
          {input.truncated && `\n${t("approval.truncated")}`}
        </pre>
      </details>
      {readOnly ? null : denying ? (
        <form className="a-stack" onSubmit={submitDeny}>
          <Field
            multiline
            rows={2}
            label={t("approval.reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="a-actions">
            <Button type="submit" variant="danger" busy={decide.isPending}>
              {t("approval.deny")}
            </Button>
            <Button variant="ghost" onClick={() => setDenying(false)}>
              {t("feedback.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="a-actions">
          <Button variant="primary" busy={decide.isPending} onClick={() => send("allow")}>
            {t("approval.allow")}
          </Button>
          <Button variant="secondary" onClick={() => setDenying(true)}>
            {t("approval.deny")}…
          </Button>
        </div>
      )}
    </article>
  );
}

/** The run's pending approvals, inside its section of the task panel. */
export function RunApprovals({
  approvals,
  readOnly,
}: {
  approvals: readonly Approval[];
  readOnly: boolean;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="a-stack">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} readOnly={readOnly} />
      ))}
    </div>
  );
}

/** Global notice on the project's page: pending approvals, each with a link to its task. */
export function ApprovalNotice({
  approvals,
  onOpen,
}: {
  approvals: readonly Approval[];
  onOpen: (task: string) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <section className="a-callout a-callout--warn b-approvals" aria-label={t("approval.notice")}>
      <p className="a-callout__text" role="status">
        <b>
          {t(approvals.length === 1 ? "approval.notice.one" : "approval.notice.many", {
            n: approvals.length,
          })}
        </b>
      </p>
      <ul className="b-approvals__list">
        {approvals.map((approval) => (
          <li key={approval.id}>
            <button type="button" className="a-link" onClick={() => onOpen(approval.task)}>
              {approval.task}
            </button>{" "}
            <span className="k-mono">{approval.tool}</span>
            {approvalSummary(approval.input) && (
              <span className="k-mono s-muted"> · {approvalSummary(approval.input)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
