/**
 * Recipe + run-audit route dispatcher — extracted from src/server.ts.
 *
 * Owns 16 routes covering the recipe authoring loop (CRUD + lint + run),
 * the run-audit log (`/runs`, `/runs/:seq`, replay, plan), the public
 * template registry (`/templates`), and recipe installation
 * (`/recipes/install`). Plus the `/activation-metrics` siblings that
 * read the same audit log.
 *
 * DI shape: handlers depend on 12 nullable callbacks the bridge wires
 * onto the Server instance post-construction (`runRecipeFn`,
 * `recipesFn`, etc.). They're passed as a `RecipeRouteDeps` struct
 * matching the pattern from oauthRoutes.ts and mcpRoutes.ts.
 *
 * Module-level state: the `/templates` 5-minute cache used to live as
 * `_templatesCache`/`_templatesCacheTs` instance fields on Server.
 * Lifetime is process-wide either way (Server is a singleton in
 * practice), so hoisting to module scope here is equivalent and avoids
 * threading a mutable holder through `deps`.
 *
 * Mechanical lift: handler bodies are byte-identical save for
 * `deps.<fn>` replacing `this.<fn>` and module-scoped cache vars
 * replacing `this._templatesCache`. A few routes that previously used
 * `await` directly in their async parent closure are wrapped in
 * `void (async () => {...})()` so this module can return boolean
 * synchronously — same micro-task tradeoff documented in
 * connectorRoutes.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  computeSummary as computeActivationSummary,
  loadMetrics as loadActivationMetrics,
} from "./activationMetrics.js";
import type { RecipeDraft } from "./recipesHttp.js";

// 5-minute cache of the public template registry from the patchworkos/recipes
// GitHub repo. Process-wide; hoisted out of Server class state.
let templatesCache: unknown = null;
let templatesCacheTs = 0;

export interface RecipeRouteDeps {
  recipesFn: (() => Record<string, unknown>) | null;
  loadRecipeContentFn:
    | ((name: string) => { content: string; path: string } | null)
    | null;
  saveRecipeContentFn:
    | ((
        name: string,
        content: string,
      ) => {
        ok: boolean;
        path?: string;
        error?: string;
        warnings?: string[];
      })
    | null;
  deleteRecipeContentFn:
    | ((name: string) => { ok: boolean; path?: string; error?: string })
    | null;
  lintRecipeContentFn:
    | ((content: string) => {
        ok: boolean;
        errors: string[];
        warnings: string[];
      })
    | null;
  saveRecipeFn:
    | ((draft: RecipeDraft) => { ok: boolean; path?: string; error?: string })
    | null;
  setRecipeEnabledFn:
    | ((name: string, enabled: boolean) => { ok: boolean; error?: string })
    | null;
  runsFn:
    | ((q: {
        limit?: number;
        trigger?: string;
        status?: string;
        recipe?: string;
        after?: number;
      }) => Record<string, unknown>[])
    | null;
  runDetailFn: ((seq: number) => Record<string, unknown> | null) | null;
  runPlanFn: ((recipeName: string) => Promise<Record<string, unknown>>) | null;
  runReplayFn:
    | ((seq: number) => Promise<{
        ok: boolean;
        newSeq?: number;
        unmockedSteps?: string[];
        error?: string;
      }>)
    | null;
  runRecipeFn:
    | ((
        name: string,
        vars?: Record<string, string>,
      ) => Promise<{ ok: boolean; taskId?: string; error?: string }>)
    | null;
}

/**
 * Try to handle a recipe / run-audit / template route. Returns true if
 * the route was dispatched (caller should `return` from the request
 * handler), false if no route matched.
 *
 * Must be called AFTER bearer-auth — none of these routes are public.
 */
export function tryHandleRecipeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  deps: RecipeRouteDeps,
): boolean {
  const recipeNameRunMatch =
    req.method === "POST"
      ? /^\/recipes\/([^/]+)\/run$/.exec(parsedUrl.pathname)
      : null;
  if (recipeNameRunMatch) {
    const nameFromPath = decodeURIComponent(recipeNameRunMatch[1] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          const parsed = body
            ? (JSON.parse(body) as {
                vars?: Record<string, string>;
                inputs?: Record<string, string>;
              })
            : {};
          const varsRaw = parsed.vars ?? parsed.inputs;
          const vars =
            varsRaw && typeof varsRaw === "object" && !Array.isArray(varsRaw)
              ? (varsRaw as Record<string, string>)
              : undefined;
          if (!deps.runRecipeFn) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  "Recipe execution unavailable — requires --claude-driver subprocess",
              }),
            );
            return;
          }
          const result = await deps.runRecipeFn(nameFromPath, vars);
          res.writeHead(result.ok ? 200 : 400, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        }
      })();
    });
    return true;
  }

  if (parsedUrl.pathname === "/recipes/run" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          const parsed = JSON.parse(body || "{}") as {
            name?: string;
            vars?: Record<string, string>;
          };
          const name = parsed.name;
          const vars =
            parsed.vars &&
            typeof parsed.vars === "object" &&
            !Array.isArray(parsed.vars)
              ? (parsed.vars as Record<string, string>)
              : undefined;
          if (typeof name !== "string" || !name) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "name required" }));
            return;
          }
          if (!deps.runRecipeFn) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  "Recipe execution unavailable — requires --claude-driver subprocess",
              }),
            );
            return;
          }
          const result = await deps.runRecipeFn(name, vars);
          res.writeHead(result.ok ? 200 : 400, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        }
      })();
    });
    return true;
  }

  if (parsedUrl.pathname === "/activation-metrics" && req.method === "GET") {
    try {
      const metrics = loadActivationMetrics();
      const summary = computeActivationSummary(metrics);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ metrics, summary }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return true;
  }

  if (parsedUrl.pathname === "/runs" && req.method === "GET") {
    try {
      const sp = parsedUrl.searchParams;
      const limitRaw = sp.get("limit");
      const afterRaw = sp.get("after");
      const trigger = sp.get("trigger");
      const status = sp.get("status");
      const recipe = sp.get("recipe");
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
      const after = afterRaw ? Number.parseInt(afterRaw, 10) : Number.NaN;
      const runs =
        deps.runsFn?.({
          ...(Number.isFinite(limit) && { limit }),
          ...(trigger && { trigger }),
          ...(status && { status }),
          ...(recipe && { recipe }),
          ...(Number.isFinite(after) && { after }),
        }) ?? [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runs }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return true;
  }

  // GET /runs/:seq — single run detail (includes stepResults if present)
  const runDetailMatch =
    req.method === "GET" ? /^\/runs\/(\d+)$/.exec(parsedUrl.pathname) : null;
  if (runDetailMatch?.[1]) {
    const seq = Number.parseInt(runDetailMatch[1], 10);
    try {
      const run = deps.runDetailFn?.(seq) ?? null;
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return true;
  }

  // POST /runs/:seq/replay — VD-4 mocked replay. Re-runs the recipe with all
  // tool/agent execution intercepted to return captured outputs from the
  // original run. No external IO, no side effects. Real-mode replay is not
  // exposed here yet — must ship separately with confirmation UX +
  // kill-switch interaction.
  const runReplayMatch =
    req.method === "POST"
      ? /^\/runs\/(\d+)\/replay$/.exec(parsedUrl.pathname)
      : null;
  if (runReplayMatch?.[1]) {
    const seq = Number.parseInt(runReplayMatch[1], 10);
    void (async () => {
      try {
        if (!deps.runReplayFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "replay_unavailable" }));
          return;
        }
        const result = await deps.runReplayFn(seq);
        if (result.error === "run_not_found") {
          res.writeHead(404, { "Content-Type": "application/json" });
        } else if (!result.ok) {
          res.writeHead(500, { "Content-Type": "application/json" });
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    })();
    return true;
  }

  // GET /runs/:seq/plan — dry-run plan for the recipe that produced this run
  const runPlanMatch =
    req.method === "GET"
      ? /^\/runs\/(\d+)\/plan$/.exec(parsedUrl.pathname)
      : null;
  if (runPlanMatch?.[1]) {
    const seq = Number.parseInt(runPlanMatch[1], 10);
    void (async () => {
      try {
        const run = deps.runDetailFn?.(seq) ?? null;
        if (!run) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "run_not_found" }));
          return;
        }
        if (!deps.runPlanFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "plan_unavailable" }));
          return;
        }
        // triggerSource appends ":agent" suffix — strip before file lookup
        const recipeName = (run.recipeName as string).replace(/:agent$/, "");
        const plan = await deps.runPlanFn(recipeName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ plan }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status =
          msg.includes("not found") || msg.includes("ENOENT") ? 404 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    })();
    return true;
  }

  if (req.url === "/recipes" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const draft = JSON.parse(body || "{}") as RecipeDraft;
        if (typeof draft.name !== "string" || !draft.name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "name required" }));
          return;
        }
        if (!deps.saveRecipeFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe saving unavailable",
            }),
          );
          return;
        }
        const result = deps.saveRecipeFn(draft);
        res.writeHead(result.ok ? 201 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      }
    });
    return true;
  }

  const recipePatchMatch = /^\/recipes\/([^/]+)$/.exec(parsedUrl.pathname);
  if (recipePatchMatch && req.method === "PATCH") {
    const name = decodeURIComponent(recipePatchMatch[1] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          enabled?: boolean;
        };
        if (typeof body.enabled !== "boolean") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "enabled (boolean) required",
            }),
          );
          return;
        }
        if (!deps.setRecipeEnabledFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Not available" }));
          return;
        }
        const result = deps.setRecipeEnabledFn(name, body.enabled);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (parsedUrl.pathname === "/recipes/lint" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          content?: string;
        };
        if (typeof body?.content !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "content (string) required",
            }),
          );
          return;
        }
        if (!deps.lintRecipeContentFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe lint unavailable",
            }),
          );
          return;
        }
        const result = deps.lintRecipeContentFn(body.content);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      }
    });
    return true;
  }

  const recipeContentMatch = /^\/recipes\/([^/]+)$/.exec(parsedUrl.pathname);
  if (recipeContentMatch && req.method === "GET") {
    const name = decodeURIComponent(recipeContentMatch[1] ?? "");
    if (!deps.loadRecipeContentFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: "Recipe content unavailable" }),
      );
      return true;
    }
    const result = deps.loadRecipeContentFn(name);
    if (!result) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Recipe not found" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  if (recipeContentMatch && req.method === "PUT") {
    const name = decodeURIComponent(recipeContentMatch[1] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          content?: string;
        };
        if (typeof body.content !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "content (string) required",
            }),
          );
          return;
        }
        if (!deps.saveRecipeContentFn) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Recipe content saving unavailable",
            }),
          );
          return;
        }
        const result = deps.saveRecipeContentFn(name, body.content);
        res.writeHead(result.ok ? 200 : 400, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      }
    });
    return true;
  }

  if (recipeContentMatch && req.method === "DELETE") {
    const name = decodeURIComponent(recipeContentMatch[1] ?? "");
    if (!deps.deleteRecipeContentFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "Recipe deletion unavailable",
        }),
      );
      return true;
    }
    const result = deps.deleteRecipeContentFn(name);
    const status = result.ok
      ? 200
      : result.error === "Recipe not found"
        ? 404
        : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  if (req.url === "/recipes" && req.method === "GET") {
    try {
      const data = deps.recipesFn?.() ?? { recipesDir: null, recipes: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return true;
  }

  if (parsedUrl.pathname === "/templates" && req.method === "GET") {
    void (async () => {
      try {
        const now = Date.now();
        if (!templatesCache || now - templatesCacheTs > 5 * 60 * 1000) {
          const ghRes = await fetch(
            "https://raw.githubusercontent.com/patchworkos/recipes/main/index.json",
          );
          if (!ghRes.ok) {
            throw new Error(`GitHub returned ${ghRes.status}`);
          }
          templatesCache = (await ghRes.json()) as unknown;
          templatesCacheTs = now;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(templatesCache));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })();
    return true;
  }

  if (parsedUrl.pathname === "/recipes/install" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const { source } = JSON.parse(body) as { source?: string };
        if (!source) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing source field" }));
          return;
        }
        const githubPrefix = "github:patchworkos/recipes/recipes/";
        let fetchUrl: string;
        let recipeName: string;
        if (source.startsWith(githubPrefix)) {
          recipeName = source.slice(githubPrefix.length);
          fetchUrl = `https://raw.githubusercontent.com/patchworkos/recipes/main/recipes/${recipeName}/${recipeName}.yaml`;
        } else if (source.startsWith("https://")) {
          fetchUrl = source;
          const urlParts = fetchUrl.split("/");
          recipeName = (urlParts[urlParts.length - 1] ?? "recipe").replace(
            /\.ya?ml$/i,
            "",
          );
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "Unsupported source format",
            }),
          );
          return;
        }
        const yamlRes = await fetch(fetchUrl);
        if (!yamlRes.ok) {
          throw new Error(
            `Fetch failed: ${yamlRes.status} ${yamlRes.statusText}`,
          );
        }
        const yamlText = await yamlRes.text();
        const tmpFile = path.join(
          os.tmpdir(),
          `patchwork-install-${Date.now()}-${recipeName}.yaml`,
        );
        const { writeFileSync, mkdirSync, unlinkSync } = await import(
          "node:fs"
        );
        writeFileSync(tmpFile, yamlText, "utf-8");
        let result: { action: "created" | "replaced"; name: string };
        try {
          const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
          mkdirSync(recipesDir, { recursive: true });
          const { installRecipeFromFile } = await import(
            "./recipes/installer.js"
          );
          const installResult = installRecipeFromFile(tmpFile, {
            recipesDir,
          });
          result = { action: installResult.action, name: recipeName };
        } finally {
          try {
            unlinkSync(tmpFile);
          } catch {
            // best-effort cleanup
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });
    return true;
  }

  return false;
}
