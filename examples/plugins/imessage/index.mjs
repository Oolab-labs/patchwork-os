/**
 * imessage — Patchwork OS plugin.
 *
 * Single tool `im_send`: deliver a message via macOS Messages.app to a
 * phone number (E.164) or Apple ID email. Backed by `osascript`; the
 * Mac running the bridge must be signed into iMessage and the user
 * must approve Automation access for the host process the first time
 * the tool runs (System Settings → Privacy & Security → Automation).
 *
 * The AppleScript is fed `to` and `body` as argv items, so the
 * message body is safe even if it contains quotes, backticks, or
 * shell metacharacters — no string interpolation into the script
 * source.
 */

import { spawn } from "node:child_process";
import os from "node:os";

const MAX_BODY_BYTES = 10_000;

// E.164 ("+14155551234") or basic email shape — anything else is rejected
// before we shell out, so user mistakes surface as a clear error rather
// than a silent Messages.app no-op.
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidRecipient(to) {
  if (typeof to !== "string") return false;
  return PHONE_RE.test(to) || EMAIL_RE.test(to);
}

const APPLESCRIPT = `on run argv
  set toAddr to item 1 of argv
  set msgText to item 2 of argv
  tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy toAddr of targetService
    send msgText to targetBuddy
  end tell
end run`;

/**
 * Run osascript with the recipient + body passed as argv (osascript
 * shell-escapes them for us; we never interpolate into AppleScript
 * source). Resolves with stdout/stderr/exitCode regardless of success.
 */
function runOsascript(to, body, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", ["-e", APPLESCRIPT, "--", to, body], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      proc.kill("SIGKILL");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", onAbort);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/** @param {import('patchwork-os/plugin').PluginContext} ctx */
export function register(ctx) {
  ctx.logger.info("imessage plugin loaded", {
    workspace: ctx.workspace,
    platform: os.platform(),
  });

  return {
    tools: [
      {
        schema: {
          name: "im_send",
          description:
            "Send an iMessage to a phone number (E.164 like +14155551234) or " +
            "Apple ID email. Requires macOS with Messages.app signed in. " +
            "Falls back to SMS only if SMS-via-iPhone forwarding is enabled. " +
            "First run will trigger a one-time macOS Automation permission prompt.",
          inputSchema: {
            type: "object",
            required: ["to", "body"],
            additionalProperties: false,
            properties: {
              to: {
                type: "string",
                description:
                  "Recipient: E.164 phone number (e.g. +14155551234) or Apple ID email.",
              },
              body: {
                type: "string",
                description: `Message body. Max ${MAX_BODY_BYTES} bytes UTF-8.`,
              },
              timeoutMs: {
                type: "integer",
                description:
                  "Hard timeout for the osascript subprocess. Default 15000.",
                minimum: 1000,
                maximum: 120_000,
                default: 15_000,
              },
            },
          },
          outputSchema: {
            type: "object",
            required: ["delivered", "to"],
            properties: {
              delivered: { type: "boolean" },
              to: { type: "string" },
              stderr: { type: "string" },
            },
          },
          annotations: {
            // Sending a message is a side effect on the user's phone +
            // contact's phone — never advertise this as read-only.
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        handler: async (args, signal) => {
          if (os.platform() !== "darwin") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    "im_send only works on macOS — Messages.app is required. " +
                    `Detected platform: ${os.platform()}.`,
                },
              ],
            };
          }

          const to = String(args.to ?? "");
          const body = String(args.body ?? "");
          const timeoutMs = Math.min(
            Math.max(1000, Number(args.timeoutMs) || 15_000),
            120_000,
          );

          if (!isValidRecipient(to)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `im_send: invalid 'to' value. Expected E.164 phone number ` +
                    `(e.g. +14155551234) or Apple ID email. Got: ${to.slice(0, 80)}`,
                },
              ],
            };
          }
          if (body.length === 0) {
            return {
              isError: true,
              content: [
                { type: "text", text: "im_send: 'body' must be non-empty." },
              ],
            };
          }
          if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `im_send: body exceeds ${MAX_BODY_BYTES} bytes UTF-8.`,
                },
              ],
            };
          }

          let result;
          try {
            result = await runOsascript(to, body, signal, timeoutMs);
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `im_send: failed to spawn osascript — ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                },
              ],
            };
          }

          if (result.exitCode !== 0) {
            // Common failure modes the user can act on without reading logs:
            //   - "-1743" / "Not authorized" → Automation permission missing
            //   - "execution error: ... (-25212)" → buddy not found / no iMessage account
            const hint = /-1743|not authorized|automation/i.test(result.stderr)
              ? " Grant Automation → Messages permission in System Settings → Privacy & Security."
              : /-25212|buddy/i.test(result.stderr)
                ? " Recipient not reachable on iMessage from this Mac. Check the number/email and that Messages is signed in."
                : "";
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `im_send: osascript exited ${result.exitCode}.${hint}\n` +
                    (result.stderr ? `stderr: ${result.stderr.trim()}` : ""),
                },
              ],
              structuredContent: {
                delivered: false,
                to,
                stderr: result.stderr,
              },
            };
          }

          ctx.logger.info("im_send delivered", { to, bytes: body.length });
          return {
            content: [
              {
                type: "text",
                text: `Sent to ${to} (${body.length} chars).`,
              },
            ],
            structuredContent: {
              delivered: true,
              to,
              stderr: result.stderr,
            },
          };
        },
        timeoutMs: 30_000,
      },
    ],
  };
}
