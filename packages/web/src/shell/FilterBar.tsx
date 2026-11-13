import { type FilterFacets, isFilterActive, type TaskFilter } from "@konsora/core";
import { useId } from "react";
import { t } from "../i18n/index.ts";
import { Button, difficultyLabel, Field } from "../ui/index.ts";

/** An actor as people read it: «tú» for the human, the bare name for an agent. */
const actorLabel = (actor: string) =>
  actor === "human" ? t("detail.you") : actor.replace(/^agent:/, "");

function Choice({
  label,
  all,
  value,
  options,
  onChange,
}: {
  label: string;
  /** The text of the option that does not filter. */
  all: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  // A value from the URL that the plan no longer has stays listed, so it can be seen and removed.
  const listed = options.some((option) => option.value === value)
    ? options
    : [...options, { value, label: value }];
  return (
    <div className="k-field b-filter__choice">
      <label htmlFor={id} className="k-field__label k-visually-hidden">
        {label}
      </label>
      <select
        id={id}
        className="k-field__control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{all}</option>
        {(value ? listed : options).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The task filter of the board and the graph (UI-10): free text, group, label and who created or
 * closed the task. It only narrows what is shown; the filter itself lives in the URL.
 */
export function FilterBar({
  filter,
  groups,
  facets,
  hidden,
  onChange,
}: {
  filter: TaskFilter;
  groups: readonly { id: string; name: string }[];
  facets: FilterFacets;
  /** How many tasks the filter leaves out. */
  hidden: number;
  onChange: (filter: TaskFilter) => void;
}) {
  const active = isFilterActive(filter);
  const set = (key: keyof TaskFilter, value: string) => {
    const next = { ...filter };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  return (
    <search className="b-filter" aria-label={t("filter.label")}>
      <div className="b-filter__text">
        <Field
          type="search"
          label={t("filter.text")}
          hideLabel
          placeholder={t("filter.text.placeholder")}
          value={filter.text ?? ""}
          onChange={(event) => set("text", event.target.value)}
        />
      </div>
      <Choice
        label={t("filter.group")}
        all={t("filter.group.all")}
        value={filter.group ?? ""}
        options={groups.map((group) => ({
          value: group.id,
          label: `${group.id} · ${group.name}`,
        }))}
        onChange={(value) => set("group", value)}
      />
      {(facets.labels.length > 0 || filter.label) && (
        <Choice
          label={t("filter.tag")}
          all={t("filter.tag.all")}
          value={filter.label ?? ""}
          options={facets.labels.map((label) => ({ value: label, label }))}
          onChange={(value) => set("label", value)}
        />
      )}
      {(facets.actors.length > 1 || filter.by) && (
        <Choice
          label={t("filter.by")}
          all={t("filter.by.all")}
          value={filter.by ?? ""}
          options={facets.actors.map((actor) => ({ value: actor, label: actorLabel(actor) }))}
          onChange={(value) => set("by", value)}
        />
      )}
      {(facets.difficulties.length > 1 || filter.difficulty) && (
        <Choice
          label={t("filter.difficulty")}
          all={t("filter.difficulty.all")}
          value={filter.difficulty ?? ""}
          options={facets.difficulties.map((level) => ({
            value: level,
            label: level === "none" ? t("difficulty.none") : difficultyLabel(level),
          }))}
          onChange={(value) => set("difficulty", value)}
        />
      )}
      {active && (
        <>
          <span className="b-filter__hidden" role="status">
            {t(hidden === 1 ? "filter.hidden.one" : "filter.hidden.many", { n: hidden })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            {t("filter.clear")}
          </Button>
        </>
      )}
    </search>
  );
}
