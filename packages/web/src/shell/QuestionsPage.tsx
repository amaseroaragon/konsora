/**
 * UI-13: the questions agents are waiting on, in every linked project, answered one after another
 * without leaving the page. The header's link counts them.
 */
import { useState } from "react";
import { type PendingQuestion, type QuestionGroup, useQuestions } from "../api/questions.ts";
import { t } from "../i18n/index.ts";
import { Panel } from "../ui/index.ts";
import { projectHref, QUESTIONS_HREF } from "./route.ts";
import { QueryError } from "./Shell.tsx";
import { Actions } from "./TaskPanel.tsx";

const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

/** The header link to the pending questions, with how many there are. */
export function QuestionsLink({ current }: { current: boolean }) {
  const questions = useQuestions();
  const total = questions.data?.total ?? 0;
  return (
    <a
      className="s-nav__link"
      href={QUESTIONS_HREF}
      aria-current={current ? "page" : undefined}
      aria-label={t("questions.nav.label", { n: total })}
    >
      {t("questions.nav")}
      {total > 0 && <span className="s-nav__count">{total}</span>}
    </a>
  );
}

function Question({
  projectId,
  item,
  onAnswered,
}: {
  projectId: string;
  item: PendingQuestion;
  onAnswered: () => void;
}) {
  const { task, question } = item;
  return (
    <li className="s-question">
      <div className="s-question__head">
        <a
          className="s-question__task"
          href={projectHref(projectId, { task: task.id })}
          aria-label={t("questions.open", { id: task.id })}
        >
          <span className="k-mono">{task.id}</span> {task.title}
        </a>
        <span className="s-question__meta">
          {t("questions.asked", {
            actor: question.by.replace(/^agent:/, ""),
            when: when(question.at),
          })}
        </span>
      </div>
      <Actions
        projectId={projectId}
        task={task}
        actions={["answer"]}
        dependents={[]}
        onDone={onAnswered}
      />
    </li>
  );
}

function ProjectQuestions({
  group,
  answered,
  onAnswered,
}: {
  group: QuestionGroup;
  answered: ReadonlySet<string>;
  onAnswered: (key: string) => void;
}) {
  const { project } = group;
  const pending = group.questions.filter(
    (q) => !answered.has(`${project.id}:${q.question.id}:${q.task.id}`),
  );
  if (pending.length === 0) return null;
  const headingId = `questions-${project.id}`;
  return (
    <section className="s-questions__project" aria-labelledby={headingId}>
      <h3 className="s-questions__name" id={headingId}>
        <a
          href={projectHref(project.id)}
          aria-label={t("questions.project", { name: project.name })}
        >
          {project.name}
        </a>
        <span className="s-questions__count">{pending.length}</span>
      </h3>
      <ul className="s-questions__list">
        {pending.map((item) => {
          const key = `${project.id}:${item.question.id}:${item.task.id}`;
          return (
            <Question
              key={`${key}:${item.task.hash}`}
              projectId={project.id}
              item={item}
              onAnswered={() => onAnswered(key)}
            />
          );
        })}
      </ul>
    </section>
  );
}

export function QuestionsPage() {
  const questions = useQuestions();
  // Hidden as soon as they are answered, before the list is refetched.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const groups = questions.data?.projects ?? [];
  const left = groups.reduce(
    (sum, group) =>
      sum +
      group.questions.filter(
        (q) => !answered.has(`${group.project.id}:${q.question.id}:${q.task.id}`),
      ).length,
    0,
  );
  return (
    <div className="s-questions">
      <Panel title={t("questions.title")} eyebrow={t("questions.eyebrow")}>
        <p className="s-text s-muted">{t("questions.text")}</p>
        {questions.isPending && <p className="s-text s-muted">{t("action.loading")}</p>}
        {questions.isError && (
          <QueryError error={questions.error} retry={() => questions.refetch()} />
        )}
        {questions.data && left === 0 && <p className="s-text">{t("questions.empty")}</p>}
        {groups.map((group) => (
          <ProjectQuestions
            key={group.project.id}
            group={group}
            answered={answered}
            onAnswered={(key) => setAnswered((prev) => new Set(prev).add(key))}
          />
        ))}
      </Panel>
    </div>
  );
}
