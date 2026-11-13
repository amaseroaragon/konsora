import { type FormEvent, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  type PlanStatus,
  type ProjectSummary,
  useLinkProject,
  useProjects,
  useUnlinkProject,
} from "../api/projects.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import {
  askConfirm,
  Button,
  type ConfirmAsk,
  Field,
  Panel,
  StateBadge,
  useToast,
} from "../ui/index.ts";
import { Rich } from "./Rich.tsx";
import { projectHref } from "./route.ts";
import { QueryError } from "./Shell.tsx";

export function planLabel(plan: PlanStatus): string {
  if (plan.status === "ok")
    return plan.tasks === 1 ? t("projects.plan.ok.one") : t("projects.plan.ok", { n: plan.tasks });
  if (plan.status === "missing") return t("projects.plan.missing");
  if (plan.status === "invalid") return t("projects.plan.invalid");
  return t("projects.plan.error");
}

const LINK_ERRORS: Record<string, MessageKey> = {
  not_found: "link.error.not_found",
  not_a_directory: "link.error.not_a_directory",
  inside_data_dir: "link.error.inside_data_dir",
  bad_request: "link.error.bad_request",
};

/** Spanish message for a failed link; unknown errors keep the daemon's message. */
export function linkErrorText(error: unknown): string {
  const key = error instanceof ApiError ? LINK_ERRORS[error.code] : undefined;
  return key ? t(key) : t("error.generic", { message: (error as Error).message });
}

/** Unlinking forgets the project in Konsora (its folder is untouched), but only after a yes. */
export function confirmUnlink(name: string, ask: ConfirmAsk): Promise<boolean> {
  return ask(t("projects.unlink.confirm", { name }), { yes: t("projects.unlink"), danger: true });
}

const counted = (n: number, one: MessageKey, other: MessageKey) =>
  n === 1 ? t(one) : t(other, { n });

/** A readable plan at a glance (UI-14): size, what is moving, what needs the human, last closure. */
export function PlanStats({ plan }: { plan: Extract<PlanStatus, { status: "ok" }> }) {
  const lastDone = plan.lastDone
    ? new Date(plan.lastDone).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })
    : null;
  return (
    <ul className="s-project__stats" aria-label={t("projects.stats")}>
      {plan.waiting > 0 && (
        <li>
          <StateBadge
            kind="waiting"
            label={counted(plan.waiting, "projects.stats.waiting.one", "projects.stats.waiting")}
          />
        </li>
      )}
      <li>{planLabel(plan)}</li>
      {plan.byState.doing > 0 && <li>{t("projects.stats.doing", { n: plan.byState.doing })}</li>}
      {plan.ready > 0 && (
        <li>{counted(plan.ready, "projects.stats.ready.one", "projects.stats.ready")}</li>
      )}
      <li>
        {lastDone ? t("projects.stats.lastDone", { when: lastDone }) : t("projects.stats.noneDone")}
      </li>
    </ul>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const unlink = useUnlinkProject();
  const toast = useToast();
  const onUnlink = async () => {
    if (!(await confirmUnlink(project.name, askConfirm))) return;
    unlink.mutate(project.id, {
      onSuccess: () => toast.show(t("projects.unlinked", { name: project.name }), "success"),
      onError: (error) => toast.show(t("error.generic", { message: error.message }), "error"),
    });
  };
  return (
    <li
      className={`s-project${project.plan.status === "ok" && project.plan.waiting > 0 ? " s-project--waiting" : ""}`}
    >
      <a
        className="s-project__open"
        href={projectHref(project.id)}
        aria-label={t("projects.open", { name: project.name })}
      >
        <span className="s-project__name">{project.name}</span>
        <span className="s-project__path">{project.path}</span>
      </a>
      {project.plan.status === "ok" ? (
        <PlanStats plan={project.plan} />
      ) : (
        <span className={`s-project__plan s-project__plan--${project.plan.status}`}>
          <Rich text={planLabel(project.plan)} />
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        busy={unlink.isPending}
        aria-label={t("projects.unlink.label", { name: project.name })}
        onClick={() => void onUnlink()}
      >
        {t("projects.unlink")}
      </Button>
    </li>
  );
}

function LinkForm() {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const link = useLinkProject();
  const toast = useToast();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const input = { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
    link.mutate(input, {
      onSuccess: (project) => {
        toast.show(t("link.done", { name: project.name }), "success");
        setPath("");
        setName("");
      },
    });
  };
  return (
    <Panel title={t("link.title")}>
      <form className="s-form" onSubmit={onSubmit}>
        <p className="s-text s-muted">{t("link.text")}</p>
        <Field
          label={t("link.path")}
          mono
          required
          value={path}
          placeholder={t("link.path.placeholder")}
          error={link.isError ? linkErrorText(link.error) : undefined}
          onChange={(event) => {
            setPath(event.target.value);
            if (link.isError) link.reset();
          }}
        />
        <Field
          label={t("link.name")}
          hint={t("link.name.hint")}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div>
          <Button type="submit" variant="primary" busy={link.isPending} disabled={!path.trim()}>
            {t("link.submit")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function ProjectsPage() {
  const projects = useProjects();
  return (
    <div className="s-columns">
      <Panel title={t("projects.title")} eyebrow={t("projects.eyebrow")}>
        {projects.isPending && <p className="s-text s-muted">{t("action.loading")}</p>}
        {projects.isError && <QueryError error={projects.error} retry={() => projects.refetch()} />}
        {projects.data?.length === 0 && (
          <p className="s-text s-muted">
            <Rich text={t("projects.empty")} />
          </p>
        )}
        {projects.data && projects.data.length > 0 && (
          <ul className="s-projects">
            {projects.data.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </ul>
        )}
      </Panel>
      <LinkForm />
    </div>
  );
}
