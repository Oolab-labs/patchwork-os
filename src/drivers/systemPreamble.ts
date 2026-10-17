/**
 * Deliver `ProviderTaskInput.systemPrompt` to a CLI that has no flag for it
 * (audit M25).
 *
 * The Claude CLI takes `--system-prompt`. The gemini and codex CLIs have no
 * headless flag that ADDS one — gemini's GEMINI_SYSTEM_MD replaces its whole
 * built-in prompt — so both drivers used to drop the field, and a governed
 * recipe routed to either ran without the instruction that `<untrusted>`
 * blocks are data. Here it is placed ahead of the task in a delimited block.
 *
 * This is weaker than a true system channel: the model sees it as part of the
 * user turn. It is still the operator's instruction arriving before any
 * enveloped content, which is what the governed profile promises.
 */
export function withSystemPreamble(
  prompt: string,
  systemPrompt: string | undefined,
): string {
  if (!systemPrompt) return prompt;
  return `<system-instructions>\n${systemPrompt}\n</system-instructions>\n\n${prompt}`;
}
