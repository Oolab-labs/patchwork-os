/**
 * Compiled output of src/index.ts — committed so the plugin runs without
 * `npm run build` first. Re-run `npm run build` after editing src/index.ts.
 */
const GREETINGS = {
  en: (name) => `Hello, ${name}!`,
  es: (name) => `¡Hola, ${name}!`,
  fr: (name) => `Bonjour, ${name}!`,
  de: (name) => `Hallo, ${name}!`,
  ja: (name) => `こんにちは、${name}！`,
};
export function register(ctx) {
  ctx.logger.info("hello-world-ts plugin loaded");
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
          const greetFn = GREETINGS[language] ?? GREETINGS.en;
          const greeting = greetFn(name);
          ctx.logger.info(`hw.greet called: ${greeting}`);
          return { greeting, language };
        },
      },
    ],
  };
}
