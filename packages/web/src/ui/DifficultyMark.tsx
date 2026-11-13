import type { Difficulty } from "@konsora/core";
import { t } from "../i18n/index.ts";

const BARS: Record<Difficulty, number> = { low: 1, medium: 2, high: 3 };

/** «Baja», «Media» or «Alta». */
export const difficultyLabel = (difficulty: Difficulty) => t(`difficulty.${difficulty}`);

/**
 * A task's difficulty (CORE-22) as one to three bars; the level is read out and, with `text`,
 * also written next to them.
 */
export function DifficultyMark({
  difficulty,
  text = false,
}: {
  difficulty: Difficulty;
  text?: boolean;
}) {
  const label = t("difficulty.mark", { level: difficultyLabel(difficulty).toLowerCase() });
  return (
    <span className={`k-difficulty k-difficulty--${difficulty}`} title={label}>
      <span className="k-difficulty__bars" aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={
              bar <= BARS[difficulty]
                ? "k-difficulty__bar k-difficulty__bar--on"
                : "k-difficulty__bar"
            }
          />
        ))}
      </span>
      {text ? (
        <span className="k-difficulty__text">{label}</span>
      ) : (
        <span className="k-visually-hidden">{label}</span>
      )}
    </span>
  );
}
