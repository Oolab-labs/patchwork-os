/**
 * How a Decision Record's `action` is presented, in one place.
 *
 * The dashboard used to derive this inline as `const isAllow = d.action ===
 * "allow"` and render `isAllow ? "ALLOW" : "GATE"`, with the explain line
 * reading "vs required — higher". Its `action` was typed `"allow" | "gate"`,
 * so a `forbid` row fell into the else-branch and was shown to the operator as
 * a gate: a thing that needs MORE approval.
 *
 * ADR-0017 says the opposite. `forbid` is not a stronger gate — it means no
 * earned trust and no human approval unlocks the action. Telling an operator to
 * go and get approval for it inverts the entire point of the terminal state.
 *
 * The wording follows `ControlBoundary.tsx`, which already distinguishes these
 * in WORDS and not only colour ("A named person must say yes" vs "No approval
 * can unlock these"), so the difference survives greyscale and a colour-blind
 * reader. That property is easy to lose when a second surface invents its own
 * vocabulary, which is the reason this is shared rather than copied.
 */

export type GateAction = "allow" | "gate" | "forbid";

export interface GateActionLabel {
  /** Short uppercase verb shown in the row. */
  verb: string;
  /** Modifier appended to `td-gate-verb`; empty for the neutral case. */
  className: string;
  /** Completes "effective Lx vs required …". */
  requiredPhrase: string;
}

const LABELS: Readonly<Record<GateAction, GateActionLabel>> = {
  allow: {
    verb: "ALLOW",
    className: " td-gate-verb-allow",
    requiredPhrase: "— none (allowed)",
  },
  gate: {
    verb: "GATE",
    className: "",
    requiredPhrase: "higher — a named person must say yes",
  },
  forbid: {
    verb: "FORBID",
    className: " td-gate-verb-forbid",
    requiredPhrase: "— no approval can unlock this",
  },
};

/**
 * Unknown actions fall back to the FORBID presentation deliberately. A value
 * this UI does not recognise must not be shown as permitted, and of the three
 * the only safe guess is the one that tells the operator to stop. The row still
 * says what it does not know, via the verb.
 */
export function gateActionLabel(action: string): GateActionLabel {
  return (
    LABELS[action as GateAction] ?? {
      verb: action.toUpperCase(),
      className: " td-gate-verb-forbid",
      requiredPhrase: "— unrecognised decision, treat as not permitted",
    }
  );
}
