import { describe, expect, it } from "vitest";
import { createAdapter } from "../index.js";
import { validateModelChoice } from "../../patchworkConfig.js";

describe("createAdapter factory", () => {
	it("returns ClaudeAdapter for model=claude", () => {
		const a = createAdapter({ model: "claude" });
		expect(a.name).toBe("claude");
		expect(a.supportsTools()).toBe(true);
	});

	it("returns OpenAIAdapter for model=openai", () => {
		const a = createAdapter({ model: "openai", apiKeys: { openai: "sk-x" } });
		expect(a.name).toBe("openai");
	});

	it("throws on phase-1 adapters", () => {
		expect(() => createAdapter({ model: "gemini" })).toThrow(/Phase-1/);
		expect(() => createAdapter({ model: "grok" })).toThrow(/Phase-1/);
		expect(() => createAdapter({ model: "local" })).toThrow(/Phase-1/);
	});

	it("throws on unknown model", () => {
		expect(() =>
			createAdapter({ model: "bogus" as never }),
		).toThrow(/Unknown model/);
	});
});

describe("validateModelChoice", () => {
	it("accepts valid models", () => {
		for (const m of ["claude", "openai", "gemini", "grok", "local"]) {
			expect(validateModelChoice(m)).toBe(true);
		}
	});
	it("rejects invalid", () => {
		expect(validateModelChoice("gpt4")).toBe(false);
		expect(validateModelChoice("")).toBe(false);
	});
});
