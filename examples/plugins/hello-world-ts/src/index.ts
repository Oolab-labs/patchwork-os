/**
 * hello-world-ts — minimal Live Toolsmithing starter (TypeScript variant).
 *
 * Adds one tool: `hw.greet`
 * No dependencies, no filesystem access, no network calls.
 *
 * Build:    npm run build   (compiles src/index.ts → index.mjs)
 * Dev mode: npm run dev     (tsc --watch — recompile on save)
 *
 * Then run the bridge with --plugin-watch to hot-reload on each compile:
 *   claude-ide-bridge --full \
 *     --plugin ./examples/plugins/hello-world-ts \
 *     --plugin-watch
 *
 * Full authoring reference: documents/plugin-authoring.md
 */

/** Logger interface provided by the bridge. */
interface PluginLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

/** Context object passed to register(). */
interface PluginContext {
  workspace: string;
  logger: PluginLogger;
}

type Language = "en" | "es" | "fr" | "de" | "ja";

interface GreetInput {
  name: string;
  language?: Language;
}

interface GreetOutput {
  greeting: string;
  language: Language;
}

const GREETINGS: Record<Language, (name: string) => string> = {
  en: (name) => `Hello, ${name}!`,
  es: (name) => `¡Hola, ${name}!`,
  fr: (name) => `Bonjour, ${name}!`,
  de: (name) => `Hallo, ${name}!`,
  ja: (name) => `こんにちは、${name}！`,
};

export function register(ctx: PluginContext) {
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
        async handler({
          name,
          language = "en",
        }: GreetInput): Promise<GreetOutput> {
          const greetFn = GREETINGS[language] ?? GREETINGS.en;
          const greeting = greetFn(name);
          ctx.logger.info(`hw.greet called: ${greeting}`);
          return { greeting, language };
        },
      },
    ],
  };
}
