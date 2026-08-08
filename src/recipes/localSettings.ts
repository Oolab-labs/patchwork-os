/**
 * One place that decides which local model and endpoint a `driver: "local"`
 * agent step actually uses.
 *
 * ## Why this module exists
 *
 * Three things could name the local model — the step's own `model:`, the
 * `LOCAL_MODEL` environment variable, and `localModel` in the patchwork config
 * — and two different code paths disagreed about which won.
 *
 * `src/config.ts` seeds the environment from config only when the environment
 * is unset, and its comment calls that "non-destructive": the environment is
 * documented to win. `LocalApiDriver` honours that, because it reads the
 * environment. But `defaultLocalFn` read the config directly and never looked
 * at the environment at all, then applied `cfg.localModel ?? model` — putting
 * a global default ahead of the model a recipe author had written explicitly.
 *
 * The failure is silent in the direction that matters. The run completes, the
 * output looks reasonable, and the run log names the model the step ASKED for
 * while a different one answered. A run that is invalid is indistinguishable
 * from one that is not, which is worse than an error.
 *
 * This is the same class as #1256: two paths that must agree, and don't. The
 * durable fix is not to correct one path — it is to leave only one. Both the
 * caller (`agentExecutor`) and `defaultLocalFn` resolve through here, so the
 * stamped `servedBy.model` and the model the adapter receives cannot drift
 * apart.
 *
 * ## Precedence
 *
 *   model:     step `model:`  >  LOCAL_MODEL  >  config.localModel  >  fallback
 *   endpoint:  LOCAL_ENDPOINT >  config.localEndpoint               >  adapter
 *
 * Most specific first. The step is the only one of the three that was written
 * with this particular call in mind.
 *
 * ## Why the fallback is not `agentExecutor.DEFAULT_MODEL`
 *
 * That constant is `claude-haiku-4-5-20251001`, an Anthropic id, and it was the
 * fallback on the local path too — so a `driver: local` step with no `model:`
 * sent an Anthropic model name to a local server. `cfg.localModel ??` hid that
 * whenever config happened to set a local model, which is why the config
 * override was at once a bug and the only thing keeping the local path
 * working. The local chain therefore ends at a local id.
 */

/**
 * Last resort when nothing names a model. Matches `DEFAULT_MODEL` in
 * `src/adapters/local.ts` — the adapter would apply the same value itself, so
 * resolving it here changes nothing except that the run log can now record
 * what will actually be used instead of leaving it blank.
 */
export const LOCAL_FALLBACK_MODEL = "llama3";

/** The subset of the patchwork config this resolver reads. */
export interface LocalSettingsConfig {
  localEndpoint?: string;
  localModel?: string;
}

/**
 * An empty string is a value the shell hands you when a variable is exported
 * but blank (`LOCAL_MODEL=`), and it is never a model anyone meant to pick.
 * Treating it as unset keeps a stray blank from silently shadowing config.
 */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the model for a local agent call.
 *
 * @param stepModel The step's explicit `model:`, or undefined when it omitted
 *                  one. Callers must NOT substitute a default before calling —
 *                  doing so destroys the distinction between "the author chose
 *                  this" and "nobody said", which is the whole basis of the
 *                  precedence below.
 */
export function resolveLocalModel(
  stepModel: string | undefined,
  cfg: LocalSettingsConfig,
): string {
  return (
    present(stepModel) ??
    present(process.env.LOCAL_MODEL) ??
    present(cfg.localModel) ??
    LOCAL_FALLBACK_MODEL
  );
}

/**
 * Resolve the endpoint for a local agent call.
 *
 * Returns undefined when nothing is configured, so the adapter applies its own
 * default rather than this module inventing a second one.
 *
 * Note this deliberately does NOT do the SSRF check. That guard lives in
 * `isLoopbackOrPrivateEndpoint` and is already shared by every caller; a
 * second copy here is the exact duplication this module exists to remove.
 */
export function resolveLocalEndpoint(
  cfg: LocalSettingsConfig,
): string | undefined {
  return present(process.env.LOCAL_ENDPOINT) ?? present(cfg.localEndpoint);
}
