/**
 * A remembered fact, put into a person's words.
 *
 * ## Why this does NOT generate sentences
 *
 * The obvious idea is a map from predicate to a sentence template — `timezone`
 * → "Your timezone is {value}." It cannot work here, and trying would repeat a
 * mistake this page has already made twice.
 *
 * Predicates are free-form and operator-authored. The ones in the tree today
 * include `timezone`, `coffee`, `address`, `diet.avoid`, `travel.prefers` and
 * `household.spouse`, and those are only the ones somebody happened to write in
 * a test. A map built from them would cover almost nothing a real person
 * accumulates, so the fallback would carry the page — and a structural rule
 * ("Your {predicate} is {value}") reads acceptably for `timezone` and produces
 * "Your diet.avoid is nuts" for the next one.
 *
 * The page that tells somebody what a machine believes about them is the last
 * place to guess at grammar. So: no invented sentences, and no fabricated
 * subject.
 *
 * ## What it does instead
 *
 * Presents the fact as a LABELLED VALUE — the predicate as a readable term, the
 * object as its value. "Tasks default list — personal" invents nothing, drops
 * the `subject — predicate: object` shape that made Home read like a database
 * row, and stays true for a predicate nobody anticipated.
 *
 * The subject is dropped when it is the user, because "You" in front of every
 * row on a page titled "What I know about you" is noise. Any other subject is
 * shown, since a fact about somebody else is a different claim.
 *
 * ## Deliberately not shared with the memory card
 *
 * `src/butler/memoryCard.ts` renders `subject predicate: object` into a model's
 * prompt. That is a different audience with different needs — compact, literal,
 * token-budgeted — and making one function serve both would constrain the
 * human-facing wording to what suits a prompt. Two renderings of one record is
 * only drift when both claim to be the same thing.
 */

export interface FactWords {
  /** The thing being remembered, as a reader would say it. */
  term: string;
  /** What Butler believes about it. Never reworded. */
  value: string;
  /** Whose fact this is, when it is not the reader's own. */
  about?: string;
}

/**
 * `tasks.default_list` → `Tasks default list`.
 *
 * Separators become spaces and the first letter is capitalised. Nothing else:
 * no stemming, no pluralisation, no reordering. Every one of those would be a
 * guess about a word this file has never seen.
 */
export function termInWords(predicate: string): string {
  const spaced = predicate.replace(/[._-]+/g, " ").trim();
  if (spaced === "") return predicate;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function factInWords(f: {
  subject: string;
  predicate: string;
  object: string;
}): FactWords {
  return {
    term: termInWords(f.predicate),
    // An empty object is a real state — a belief recorded with no value — and
    // saying so is better than an empty cell a reader reads as a rendering bug.
    value: f.object === "" ? "(nothing recorded)" : f.object,
    ...(f.subject === "user" || f.subject === ""
      ? {}
      : { about: termInWords(f.subject) }),
  };
}

/**
 * How long ago, in words.
 *
 * Relative because "3 days ago" is what a reader actually wants to know, with
 * the exact date still shown beside it: age answers "is this current?", a date
 * answers "which day was that?", and only one of them is usually the question.
 *
 * Coarse on purpose. Minute-level precision on a fact recorded weeks ago is
 * noise, and this page has one job at this point: is this still true?
 */
export function ageInWords(recordedAt: number, now: number): string {
  const ms = now - recordedAt;
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
