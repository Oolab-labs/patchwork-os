/**
 * hello-world — minimal Live Toolsmithing starter plugin.
 *
 * Adds one tool: `hw.greet`
 * No dependencies, no filesystem access, no network calls.
 *
 * To use:
 *   claude-ide-bridge --full --plugin ./examples/plugins/hello-world --plugin-watch
 *
 * Then ask Claude: "Call hw.greet with name='World'"
 *
 * To extend:
 *   1. Edit this file and save.
 *   2. The bridge hot-reloads it (--plugin-watch).
 *   3. The same Claude session can immediately call the updated tool.
 *
 * Full authoring reference: documents/plugin-authoring.md
 */

/** @param {{ workspace: string, logger: { info: Function, error: Function } }} ctx */
export function register(ctx) {
  ctx.logger.info("hello-world plugin loaded");

  return {
    tools: [
      {
        name: "hw.greet",
        description:
          "Returns a greeting. Replace this with your own logic to create a custom tool.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name to greet",
            },
            language: {
              type: "string",
              enum: ["en", "es", "fr", "de", "ja"],
              description: "Language for the greeting (default: en)",
            },
          },
          required: ["name"],
        },
        outputSchema: {
          type: "object",
          properties: {
            greeting: { type: "string" },
            language: { type: "string" },
          },
          required: ["greeting", "language"],
        },
        async handler({ name, language = "en" }) {
          const greetings = {
            en: `Hello, ${name}!`,
            es: `¡Hola, ${name}!`,
            fr: `Bonjour, ${name}!`,
            de: `Hallo, ${name}!`,
            ja: `こんにちは、${name}！`,
          };
          const greeting = greetings[language] ?? `Hello, ${name}!`;
          ctx.logger.info(`hw.greet called: ${greeting}`);
          return { greeting, language };
        },
      },
    ],
  };
}
