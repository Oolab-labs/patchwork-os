/**
 * The `--since-days N` flag, shared by `privacy receipts`, `privacy shadow`
 * and `suggest`. Each used to parse it separately and answered a value it
 * could not use (`abc`, `-3`, `0`) with the WHOLE history, silently — a
 * different question answered as if it were the one asked (Private/52 LOW).
 */
export type SinceDays =
  | { ok: true; days?: number }
  | { ok: false; error: string };

export function parseSinceDays(args: readonly string[]): SinceDays {
  const i = args.indexOf("--since-days");
  if (i === -1) return { ok: true };
  const raw = args[i + 1];
  const n =
    raw === undefined ||
    raw === "" ||
    (raw.startsWith("-") && !/^-\d/.test(raw))
      ? Number.NaN
      : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      error: `--since-days needs a positive number of days (got ${raw === undefined ? "nothing" : JSON.stringify(raw)})`,
    };
  }
  return { ok: true, days: n };
}
