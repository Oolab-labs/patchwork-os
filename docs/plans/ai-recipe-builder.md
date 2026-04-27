# AI Recipe Builder — Implementation Plan

Natural language → recipe YAML, with voice input. Surfaced as a tab/modal on the `/recipes/new` page.

---

## Migration Gap Report: `patchwork 2.0/` → Live Dashboard

### Not Yet Migrated

| Feature | Prototype File | Complexity |
|---|---|---|
| Community Page — trending recipes, top creators, activity feed, badges, leaderboards | `dash-pages.jsx:1121–1481` | High |
| Roadmap Page — milestone cards, progress bars, timeline, expand/collapse | `dash-pages.jsx:1482–1641` | Medium |
| AI Recipe Builder — NL textarea, voice input, YAML gen | `dash-shared.jsx:112–141` | Medium–High |
| Onboarding Tour — step-by-step guided setup for first-time users | `dash-utils.jsx` | Low–Medium |

### Partially Migrated

| Feature | What's Missing |
|---|---|
| Recipes page | Install counts, star ratings, template categories, trending badges |
| Connections page | Wave categorization (MVP/Core/Expand), per-provider health pings, recently-used carousel |
| Approvals page | TTL countdown timer, inline approve button (no modal), more prominent tool summaries |
| Overview/Home | Live rolling bridge activity feed (SSE/WebSocket) |

### Not Yet Migrated — Shared Components

- `CommandPalette` (Cmd+K full search)
- `Sparkline` (inline mini-chart)
- AI builder textarea component
- `useScrollShadow` hook

### Recommended Priority

**Tier 1 (high impact):** Live activity feed → Community page → AI Recipe Builder

**Tier 2 (enhancements):** Recipe ratings/installs → Provider health dashboard → Roadmap page

**Tier 3 (polish):** Approvals TTL → Wave filters → CommandPalette → Onboarding tour

Rough total: ~138 story points (~2–3 sprints at 50pts/sprint).

Biggest architectural gaps before Tier 1 can ship: real-time SSE/WebSocket streaming (activity feed), and a user/creator system (Community page).

---

## What We're Building

A textarea where the user describes a workflow in plain English (or speaks it), and the dashboard generates a valid recipe YAML in real-time. The user reviews the streamed output, edits if needed, and confirms to save.

**No specific AI provider required.** Provider is swapped via env var.

---

## UI (from prototype `dash-shared.jsx:112–141`)

```
┌─────────────────────────────────────────────┐
│ ✦  Build with AI                            │
│                                             │
│  Describe your workflow…                    │
│  (textarea, ~4 rows)                        │
│                                             │
│  [🎤]              [▷ Preview]  [Generate →]│
└─────────────────────────────────────────────┘
  AI can make mistakes. Review before saving.
```

- Sparkle icon + "Build with AI" header
- Textarea — freeform NL description
- Mic button — voice input via `Web Speech API`
- Preview button — streams YAML into preview pane without committing
- Generate button — streams YAML, then transitions to the existing recipe editor pre-filled

---

## Integration Point

Add as a **tab** on `/recipes/new/page.tsx`:

```
[ Build manually ]  [ Build with AI ]   ← tab toggle
```

"Build with AI" tab renders the `AIRecipeBuilder` component. On confirm, it pre-fills the existing `FormState` (name, description, steps, vars, trigger) from parsed YAML — no separate page needed.

---

## Tech Stack

### AI SDK
**Vercel AI SDK** (`ai` package) — provider-agnostic, works with Next.js streaming out of the box.

```bash
npm install ai
```

Provider packages (install whichever you want to use):
```bash
npm install @ai-sdk/openai          # OpenAI / Groq / OpenRouter / Together
npm install ollama-ai-provider      # Ollama (local, free)
```

### Voice Input
Browser-native `window.SpeechRecognition` — zero deps, no API key.

Fallback: show a "not supported" toast on Firefox.

---

## Files to Create / Modify

```
dashboard/src/
  app/
    api/
      recipe/
        generate/
          route.ts           ← NEW: streaming endpoint
    recipes/
      new/
        page.tsx             ← MODIFY: add tab toggle + import AIRecipeBuilder
  components/
    AIRecipeBuilder.tsx      ← NEW: main component
    AIRecipeBuilder.test.tsx ← NEW: unit tests
```

---

## API Route — `POST /api/recipe/generate`

```ts
// route.ts
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";   // or ollama, etc.

const provider = createOpenAI({
  baseURL: process.env.AI_BASE_URL,              // e.g. http://localhost:11434/v1
  apiKey: process.env.AI_API_KEY ?? "ollama",
});

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const result = streamText({
    model: provider(process.env.AI_MODEL ?? "qwen2.5-coder"),
    system: RECIPE_SYSTEM_PROMPT,   // schema + examples
    prompt,
  });
  return result.toDataStreamResponse();
}
```

---

## System Prompt

The system prompt must include:
1. The full recipe YAML schema (copy from `documents/` or inline from existing validation)
2. 2–3 few-shot examples (simple recipe → YAML)
3. Instruction to output ONLY valid YAML, no prose

Example skeleton:
```
You are a recipe generator for Patchwork OS.
Output ONLY valid YAML conforming to this schema:
<schema>
name: string
description: string
trigger:
  type: manual | webhook | schedule
  path?: string   # webhook only
  cron?: string   # schedule only
steps:
  - id: string
    prompt: string
    agent: boolean
vars:
  - name: string
    description: string
    required: boolean
    default: string
</schema>

Examples:
<examples>
...
</examples>

Output ONLY the YAML. No explanation. No markdown fences.
```

---

## `AIRecipeBuilder` Component

```tsx
// AIRecipeBuilder.tsx
"use client";

export function AIRecipeBuilder({ onGenerated }: { onGenerated: (yaml: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [yaml, setYaml] = useState("");
  const [listening, setListening] = useState(false);

  // Vercel AI SDK hook
  const { complete, completion, isLoading } = useCompletion({
    api: "/api/recipe/generate",
  });

  async function handleGenerate() {
    setYaml("");
    await complete(prompt);
  }

  function handleVoice() {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) { toast.error("Voice not supported in this browser"); return; }
    const rec = new SR();
    rec.onresult = (e) => setPrompt(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  }

  // completion streams into yaml preview
  useEffect(() => { setYaml(completion); }, [completion]);

  return (
    <div>
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
        placeholder="Describe your workflow…" />
      <button onClick={handleVoice}>{listening ? "Listening…" : "🎤"}</button>
      <button onClick={handleGenerate} disabled={isLoading}>
        {isLoading ? "Generating…" : "Generate →"}
      </button>
      {yaml && (
        <>
          <pre>{yaml}</pre>
          <button onClick={() => onGenerated(yaml)}>Use this recipe</button>
        </>
      )}
      <p>AI can make mistakes. Review before saving.</p>
    </div>
  );
}
```

---

## Environment Variables

```env
# .env.local
AI_BASE_URL=http://localhost:11434/v1   # Ollama local (default / free)
AI_API_KEY=ollama                       # placeholder for Ollama
AI_MODEL=qwen2.5-coder                  # best for structured YAML output

# To use Groq instead (free tier, fast):
# AI_BASE_URL=https://api.groq.com/openai/v1
# AI_API_KEY=gsk_...
# AI_MODEL=llama-3.1-70b-versatile

# To use OpenRouter:
# AI_BASE_URL=https://openrouter.ai/api/v1
# AI_API_KEY=sk-or-...
# AI_MODEL=mistralai/mistral-7b-instruct
```

---

## Parsing Generated YAML → FormState

After generation, parse the YAML string into the existing `FormState` shape used by `/recipes/new/page.tsx`:

```ts
import { parse } from "yaml";   // already in the project? if not: npm install yaml

function yamlToFormState(raw: string): Partial<FormState> {
  const parsed = parse(raw);
  return {
    name: parsed.name ?? "",
    description: parsed.description ?? "",
    trigger: parsed.trigger ?? { type: "manual", path: "", cron: "" },
    steps: (parsed.steps ?? []).map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      prompt: s.prompt ?? "",
      agent: s.agent ?? false,
    })),
    vars: parsed.vars ?? [],
  };
}
```

---

## Recommended Model

| Provider | Model | Cost | Quality | Notes |
|---|---|---|---|---|
| Ollama (local) | `qwen2.5-coder:7b` | Free | Good | Best for structured YAML |
| Groq | `llama-3.1-70b-versatile` | Free tier | Great | Fast, generous limits |
| OpenRouter | `mistralai/mistral-7b-instruct` | ~$0.0001/req | Good | Pay-as-you-go |
| OpenAI | `gpt-4o-mini` | ~$0.0002/req | Best | Most reliable output |

Start with Ollama locally, swap to Groq for production (free tier handles moderate traffic).

---

## Estimated Effort

| Task | Est. |
|---|---|
| API route + system prompt | 1–2h |
| `AIRecipeBuilder` component | 2–3h |
| Voice input wiring | 30min |
| Tab toggle on `/recipes/new` | 30min |
| YAML → FormState parser | 1h |
| Tests | 1–2h |
| **Total** | **~1 day** |

---

## Open Questions

- [ ] Should generation be gated (auth required, rate-limited per user)?
- [ ] Do we want a "refine" loop — user edits the prompt and re-generates without losing context?
- [ ] Should voice input auto-trigger generation on silence, or require the user to hit Generate?
- [ ] Where do we store the few-shot examples — hardcoded in system prompt, or pulled from the recipe library dynamically?
