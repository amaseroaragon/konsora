import type { ParallelLimits, Run, SlotUsage } from "@konsora/core";
import { useState } from "react";
import type { ProjectSummary } from "../api/projects.ts";
import { useProjects } from "../api/projects.ts";
import {
  type QueueView,
  useDequeue,
  useParallel,
  useQueue,
  useQueueAction,
  useQueueEvents,
  useSetParallel,
} from "../api/queue.ts";
import { useRuns } from "../api/runs.ts";
import { t } from "../i18n/index.ts";
import { Button, Field, Panel, StateBadge, useToast } from "../ui/index.ts";
import { providerName } from "./limits-model.ts";
import {
  activeRuns,
  agentText,
  entryWaitText,
  type LimitsDraft,
  limitsDraft,
  parseLimitsDraft,
} from "./queue-model.ts";
import { projectHref } from "./route.ts";
import { RUN_STATE_KEY } from "./run-model.ts";
import { QueryError } from "./Shell.tsx";

/** `#/cola`: every project's queue and active runs, and the parallelism limits, live. */
export function QueuePage() {
  const projects = useProjects();
  const ids = (projects.data ?? []).map((p) => p.id);
  useQueueEvents(ids);
  return (
    <div className="s-stack">
      <div className="s-limits__head">
        <div>
          <h1 className="s-limits__title">{t("queue.page.title")}</h1>
          <p className="s-text s-muted">{t("queue.page.text")}</p>
        </div>
      </div>
      <ParallelPanel />
      {projects.isPending && <p className="s-text s-muted">{t("action.loading")}</p>}
      {projects.isError && <QueryError error={projects.error} retry={() => projects.refetch()} />}
      {projects.data?.length === 0 && <p className="s-text s-muted">{t("queue.none")}</p>}
      {projects.data?.map((project) => (
        <ProjectQueue key={project.id} project={project} />
      ))}
    </div>
  );
}

/** The limits shared by every project, with how many slots are in use. */
function ParallelPanel() {
  const limits = useParallel();
  if (limits.isError) return <QueryError error={limits.error} retry={() => limits.refetch()} />;
  if (!limits.data) return null;
  return <ParallelForm key={JSON.stringify(limits.data)} limits={limits.data} />;
}

function ParallelForm({ limits }: { limits: ParallelLimits }) {
  const [draft, setDraft] = useState<LimitsDraft>(() => limitsDraft(limits));
  const save = useSetParallel();
  const toast = useToast();
  const parsed = parseLimitsDraft(draft);
  const field = (key: keyof LimitsDraft) => ({
    value: draft[key],
    inputMode: "numeric" as const,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [key]: event.target.value }),
  });
  return (
    <Panel title={t("queue.limits.title")} eyebrow={t("queue.limits.eyebrow")}>
      <form
        className="s-queue__limits"
        onSubmit={(event) => {
          event.preventDefault();
          if (!parsed) return;
          save.mutate(parsed, {
            onSuccess: () => toast.show(t("queue.limits.saved"), "success"),
            onError: (error) =>
              toast.show(t("queue.error", { message: (error as Error).message }), "error"),
          });
        }}
      >
        <Field label={t("queue.limits.max")} {...field("max")} />
        {(["claude", "codex"] as const).map((provider) => (
          <Field
            key={provider}
            label={t("queue.limits.provider", { provider: providerName(provider) })}
            hint={t("queue.limits.provider.hint")}
            {...field(provider)}
          />
        ))}
        <div className="s-queue__save">
          <Button type="submit" size="sm" busy={save.isPending} disabled={!parsed}>
            {t("queue.limits.save")}
          </Button>
          {!parsed && (
            <span className="k-field__error" role="alert">
              {t("queue.limits.invalid")}
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}

function UsageLine({ usage, limits }: { usage: SlotUsage; limits: ParallelLimits }) {
  const parts = [t("queue.limits.usage", { used: usage.total, max: limits.max_parallel })];
  for (const [provider, used] of Object.entries(usage.per_provider)) {
    const cap = limits.per_provider[provider as "claude" | "codex"];
    parts.push(
      t("queue.limits.usage.provider", {
        provider: providerName(provider),
        used: cap === undefined ? String(used) : `${used}/${cap}`,
      }),
    );
  }
  return (
    <p className="s-text s-muted k-mono" role="status">
      {parts.join(" · ")}
    </p>
  );
}

/** One project: its queue state and controls, what waits and why, and its active runs. */
function ProjectQueue({ project }: { project: ProjectSummary }) {
  const queue = useQueue(project.id);
  const runs = useRuns(project.id);
  if (queue.isError) return <QueryError error={queue.error} retry={() => queue.refetch()} />;
  if (!queue.data) return null;
  return <ProjectQueueView project={project} view={queue.data} runs={activeRuns(runs.data)} />;
}

export function ProjectQueueView({
  project,
  view,
  runs,
}: {
  project: Pick<ProjectSummary, "id" | "name">;
  view: QueueView;
  runs: readonly Run[];
}) {
  const action = useQueueAction(project.id);
  const dequeue = useDequeue(project.id);
  const toast = useToast();
  const fail = (error: unknown) =>
    toast.show(t("queue.error", { message: (error as Error).message }), "error");
  const paused = view.queue.state === "paused";
  const agents = new Map(view.queue.entries.map((e) => [e.task, e.agent]));
  const empty = view.queue.entries.length === 0 && runs.length === 0;
  return (
    <Panel title={project.name} eyebrow={t(paused ? "queue.state.paused" : "queue.state.running")}>
      <div className="s-queue__bar">
        <UsageLine usage={view.usage} limits={view.limits} />
        <div className="a-actions">
          <Button
            size="sm"
            busy={action.isPending}
            onClick={() => action.mutate(paused ? "resume" : "pause", { onError: fail })}
          >
            {t(paused ? "queue.resume" : "queue.pause")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={view.queue.entries.length === 0}
            onClick={() => action.mutate("clear", { onError: fail })}
          >
            {t("queue.clear")}
          </Button>
          <a className="s-nav__link" href={projectHref(project.id)}>
            {t("queue.project.open")}
          </a>
        </div>
      </div>
      {empty ? (
        <p className="s-text s-muted">{t("queue.empty")}</p>
      ) : (
        <>
          <h3 className="k-label">{t("queue.active")}</h3>
          {runs.length === 0 ? (
            <p className="s-text s-muted">{t("queue.active.none")}</p>
          ) : (
            <ul className="s-queue__runs">
              {runs.map((run) => (
                <li key={run.id}>
                  <a className="k-mono" href={projectHref(project.id, { task: run.task })}>
                    {run.task}
                  </a>{" "}
                  · {t(RUN_STATE_KEY[run.state])} ·{" "}
                  <span className="s-muted">{agentText(run.agent)}</span>
                  {run.state === "waiting_approval" && (
                    <>
                      {" "}
                      <StateBadge kind="approval" />{" "}
                      <a href={projectHref(project.id, { task: run.task })}>
                        {t("queue.active.approval")}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {view.status.length > 0 && (
            <table className="s-limits s-queue__table">
              <caption className="k-label">{t("queue.entries")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("queue.col.task")}</th>
                  <th scope="col">{t("queue.col.agent")}</th>
                  <th scope="col">{t("queue.col.wait")}</th>
                  <th scope="col">
                    <span className="k-visually-hidden">{t("queue.remove")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.status.map((entry) => {
                  const agent = agents.get(entry.task);
                  return (
                    <tr key={entry.task}>
                      <th scope="row">
                        <a className="k-mono" href={projectHref(project.id, { task: entry.task })}>
                          {entry.task}
                        </a>
                      </th>
                      <td>{agent ? agentText(agent) : ""}</td>
                      <td>{agent ? entryWaitText(entry.wait, agent, runs) : ""}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("queue.remove.label", { id: entry.task })}
                          onClick={() => dequeue.mutate(entry.task, { onError: fail })}
                        >
                          {t("queue.remove")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}

/** The header's link to the queue view. */
export function QueueLink({ current }: { current: boolean }) {
  return (
    <a
      className="s-nav__link"
      href="#/cola"
      aria-current={current ? "page" : undefined}
      title={t("queue.nav.title")}
    >
      {t("queue.nav")}
    </a>
  );
}
