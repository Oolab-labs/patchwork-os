/**
 * Regression tests for the "Generate with AI" → "Save and edit" handoff
 * on /recipes/new.
 *
 * Audit (2026-05-06) finding: the previous handoff parsed the AI-generated
 * YAML through a form model that only knew about `agent:` steps, then
 * reserialized it via `buildRecipeYaml` — silently dropping every `tool:`
 * step (gmail.fetch_unread, github.list_*, file.write, slack.post_message,
 * etc.) the system prompt now teaches the model to emit. PR #274 routes
 * the YAML straight to `PUT /api/bridge/recipes/:name` and redirects to
 * the YAML editor, bypassing the form entirely.
 *
 * The load-bearing property: the `content` body of the PUT must equal the
 * generator's YAML byte-for-byte. These tests lock that in.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import NewRecipePage from "../page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const generatedYaml = `# yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json
apiVersion: patchwork.sh/v1
name: morning-email-digest
description: Daily summary of unread email posted to Slack
trigger:
  type: cron
  at: "0 9 * * 1-5"
  vars:
    - name: SLACK_CHANNEL
      description: Slack channel to post to
      required: true
steps:
  - tool: gmail.fetch_unread
    since: 24h
    max: 30
    into: messages
  - id: summarize
    agent:
      prompt: |
        Use ONLY the data provided below — do not call any tools.
        UNREAD EMAILS ({{messages.count}} total):
        <untrusted_data>{{messages.json}}</untrusted_data>
        Summarize actionable items in 5–10 bullets.
      into: summary
  - tool: slack.post_message
    channel: "{{SLACK_CHANNEL}}"
    text: |
      *Morning email digest*
      {{summary}}
`;

let fetchMock: Mock;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  pushMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom provides sessionStorage; clear between tests so the warnings
  // hand-off check is deterministic.
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function generateAndOpenAiPanel(prompt: string, yaml: string) {
  // First mocked fetch is the /recipes/generate proxy. Tests append a
  // second mock for the /recipes/:name PUT before clicking Save.
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { ok: true, yaml, warnings: [] }),
  );
  render(<NewRecipePage />);
  fireEvent.click(screen.getByRole("button", { name: /Generate with AI/ }));
  // The AI-prompt textarea is the only field whose placeholder begins
  // with "e.g." — stable across the placeholder copy churn from PR #275.
  fireEvent.change(screen.getByPlaceholderText(/^e\.g\./), {
    target: { value: prompt },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Generate$/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Save and edit/ }),
    ).toBeInTheDocument(),
  );
}

describe("Generate with AI → Save and edit", () => {
  it("PUTs the generated YAML byte-for-byte (preserves tool: steps)", async () => {
    await generateAndOpenAiPanel(
      "every weekday at 9am, summarize my unread Gmail and post to Slack",
      generatedYaml,
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    fireEvent.click(screen.getByRole("button", { name: /Save and edit/ }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));

    // The second fetch is the PUT we care about. Verify URL, method, and
    // — most importantly — that the `content` body equals the generator's
    // YAML byte-for-byte. If `applyAiYaml` ever regresses to round-tripping
    // through `buildRecipeYaml`, the `tool:` steps will collapse to empty
    // `agent:` steps and this comparison will fail loudly.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/bridge/recipes/morning-email-digest");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toBe(generatedYaml);

    expect(pushMock).toHaveBeenCalledWith(
      "/recipes/morning-email-digest/edit",
    );
  });

  it("forwards bridge save warnings to the edit page via sessionStorage", async () => {
    await generateAndOpenAiPanel("anything", generatedYaml);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        warnings: ['Unknown tool ID "gmail.send_message"'],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save and edit/ }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));

    const stashed = sessionStorage.getItem(
      "recipe-save-warnings:morning-email-digest",
    );
    expect(stashed).not.toBeNull();
    expect(JSON.parse(stashed as string)).toEqual([
      'Unknown tool ID "gmail.send_message"',
    ]);
  });

  it("refuses to save and shows an inline error when the YAML has no valid name", async () => {
    const yamlWithoutName = generatedYaml.replace(
      /^name:.*$/m,
      "# name omitted",
    );
    await generateAndOpenAiPanel("anything", yamlWithoutName);
    fireEvent.click(screen.getByRole("button", { name: /Save and edit/ }));

    // Only the generate fetch should have fired — no PUT, no navigation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText(/missing a valid name/i)).toBeInTheDocument();
  });

  it("surfaces a save error inline without navigating", async () => {
    await generateAndOpenAiPanel("anything", generatedYaml);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { ok: false, error: "Recipe already exists" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save and edit/ }));

    await waitFor(() =>
      expect(screen.getByText(/Recipe already exists/)).toBeInTheDocument(),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not navigate to /edit in demo mode (where the recipe was not persisted)", async () => {
    await generateAndOpenAiPanel("anything", generatedYaml);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, demo: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save and edit/ }));

    await waitFor(() =>
      expect(screen.getByText(/Demo mode/i)).toBeInTheDocument(),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });
});
