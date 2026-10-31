/**
 * Fractional ranks (docs/esquema-tareas.md §1, `rank`): non-empty strings over 0-9a-z compared
 * lexicographically (plain string comparison). A new rank can be generated between two others,
 * so reordering one task never rewrites the rest.
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const MID = DIGITS[BASE / 2] as string; // "i"
const idx = (c: string) => DIGITS.indexOf(c);

/** Some rank strictly after `a` (short when possible). */
function after(a: string): string {
  if (a === "") return MID;
  const d = idx(a[0] as string);
  if (d < BASE - 1) return DIGITS[Math.floor((d + BASE) / 2)] as string;
  return `z${after(a.slice(1))}`;
}

/** Some rank strictly between `a` and `b` in string order; throws when none exists. */
function between(a: string, b: string): string {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p === a.length) {
    // `a` is a prefix of `b`: go below b's next digit, or descend past a leading "0".
    const c = idx(b[p] as string);
    if (c > 1) return a + DIGITS[Math.floor(c / 2)];
    if (c === 1) return `${a}0${MID}`;
    const rest = b.slice(p + 1);
    if (rest === "") throw new Error(`No rank exists between "${a}" and "${b}"`);
    // Only hand-written ranks end in zeros; a shorter run of zeros is the one rank below them.
    if (/^0+$/.test(rest)) return a + "0".repeat(rest.length);
    return `${a}0${between("", rest)}`;
  }
  const ca = idx(a[p] as string);
  const cb = idx(b[p] as string);
  if (cb - ca > 1) return a.slice(0, p) + DIGITS[Math.floor((ca + cb) / 2)];
  // Adjacent digits: keep a's digit and go above the rest of `a`.
  return a.slice(0, p + 1) + after(a.slice(p + 1));
}

/**
 * A rank strictly between `before` and `after` (either may be omitted for "start"/"end").
 * Throws if `after <= before`, or if nothing fits (e.g. below "0", which is the minimum).
 * Generated ranks never end in "0", so there is always room below them.
 */
export function rankBetween(before?: string, afterRank?: string): string {
  const a = before ?? "";
  if (afterRank === undefined) return after(a);
  if (afterRank <= a) throw new Error(`rankBetween: "${afterRank}" is not after "${a}"`);
  return between(a, afterRank);
}

/** A rank after every rank in `ranks` (or a middle rank for an empty list). */
export function rankAfterAll(ranks: Iterable<string>): string {
  let max: string | undefined;
  for (const r of ranks) if (max === undefined || r > max) max = r;
  return max === undefined ? MID : after(max);
}
