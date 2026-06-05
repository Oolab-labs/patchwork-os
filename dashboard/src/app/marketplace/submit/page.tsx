"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import {
  cloneElement,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiPath } from "@/lib/api";
import { useToast } from "@/components/Toast";
import {
  analyzeTrustConsistency,
  buildGithubCreateFileUrl,
  buildManifestJson,
  extractYamlName,
  installSourceFor,
  normalizeAuthor,
  normalizeSlug,
  recipeJsonPath,
  recipeYamlPath,
  RECIPE_PRESETS,
  REGISTRY_BRANCH,
  REGISTRY_OWNER,
  REGISTRY_REPO,
  STARTER_RECIPE_YAML,
  SUBMIT_DRAFT_STORAGE_KEY,
  SUBMIT_DRAFT_TTL_MS,
  URL_SAFE_CONTENT_LIMIT,
  validateSubmission,
  type SubmissionFormData,
} from "@/lib/marketplaceSubmit";
import { AutoGrowTextarea } from "@/components/AutoGrowTextarea";
import { Dialog } from "@/components/Dialog";
import type { ApprovalBehavior, RiskLevel } from "@/lib/registry";

// CodeMirror touches `document` on mount — load it client-only.
const YamlEditor = dynamic(
  () => import("../../recipes/[...name]/_edit/_components/YamlEditor"),
  { ssr: false },
);

interface LintResult {
  /** The exact YAML text that was linted — used to drop the badge when the user edits. */
  forContent: string;
  errors: string[];
  warnings: string[];
}

type Stage = "compose" | "submitted";

interface DraftState {
  slugRaw: string;
  authorRaw: string;
  version: string;
  description: string;
  tagsInput: string;
  connectorsInput: string;
  license: string;
  homepage: string;
  riskLevel: RiskLevel;
  networkAccess: boolean;
  fileAccess: boolean;
  approvalBehavior: ApprovalBehavior;
  yaml: string;
  /**
   * Which flow stage the user was on when the draft was last saved.
   * Persisted so that refreshing the page after Submit doesn't bounce
   * the user back to compose view — they'd lose access to the "Open
   * recipe.json on GitHub" button needed for the second commit, and a
   * Submit-again would open a duplicate prefilled tab.
   */
  stage: Stage;
}

/**
 * v2 storage envelope wraps the form state with a savedAt timestamp so
 * the page can surface "restored from X days ago" and auto-expire
 * abandoned drafts. v1 (sessionStorage) is gone — its tab-scoped
 * lifetime was hostile to users who closed the tab to come back
 * tomorrow.
 */
interface DraftEnvelope {
  savedAt: number;
  data: DraftState;
}

/**
 * Returns the restored draft and how stale it is (in ms since save).
 * Auto-clears drafts older than SUBMIT_DRAFT_TTL_MS — Wave 2 fix; v1
 * had no TTL and a 6-month-old half-filled form could pollute a fresh
 * compose session indefinitely.
 */
function readDraft(): { data: DraftState; ageMs: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SUBMIT_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as Partial<DraftEnvelope>;
    const parsed = (envelope?.data ?? envelope) as Partial<DraftState>;
    const savedAt =
      typeof envelope?.savedAt === "number" ? envelope.savedAt : Date.now();
    const ageMs = Date.now() - savedAt;
    // Coarse shape guard — localStorage can be tampered with by extensions
    // or older app versions; require yaml field to be string.
    if (typeof parsed?.yaml !== "string") return null;
    // TTL check — auto-discard drafts older than 7 days.
    if (ageMs > SUBMIT_DRAFT_TTL_MS) {
      clearDraft();
      return null;
    }
    return {
      ageMs,
      data: {
        slugRaw: typeof parsed.slugRaw === "string" ? parsed.slugRaw : "",
        authorRaw:
          typeof parsed.authorRaw === "string" ? parsed.authorRaw : "",
        version: typeof parsed.version === "string" ? parsed.version : "1.0.0",
        description:
          typeof parsed.description === "string" ? parsed.description : "",
        tagsInput:
          typeof parsed.tagsInput === "string" ? parsed.tagsInput : "",
        connectorsInput:
          typeof parsed.connectorsInput === "string"
            ? parsed.connectorsInput
            : "",
        license: typeof parsed.license === "string" ? parsed.license : "MIT",
        homepage: typeof parsed.homepage === "string" ? parsed.homepage : "",
        riskLevel:
          parsed.riskLevel === "medium" || parsed.riskLevel === "high"
            ? parsed.riskLevel
            : "low",
        networkAccess: parsed.networkAccess === true,
        fileAccess: parsed.fileAccess === true,
        approvalBehavior:
          parsed.approvalBehavior === "always_ask" ||
          parsed.approvalBehavior === "auto_approve"
            ? parsed.approvalBehavior
            : "ask_on_novel",
        yaml: parsed.yaml,
        // Older drafts won't have `stage` — default to compose so an
        // older draft restored under a newer schema lands on the form,
        // not a stale submitted view.
        stage: parsed.stage === "submitted" ? "submitted" : "compose",
      },
    };
  } catch {
    return null;
  }
}

function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SUBMIT_DRAFT_STORAGE_KEY);
  } catch {
    /* storage unavailable / quota — non-fatal */
  }
}

function fmtDraftAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "less than a minute ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function MarketplaceSubmitPage() {
  const toast = useToast();

  // Lazy initializers so each useState reads from localStorage ONCE on
  // mount (no flash of empty form on hot-reload). The draft is written
  // back by a single effect lower down so we don't pay per-keystroke
  // JSON serialisation in every setter. Wave 2: storage moved from
  // sessionStorage (tab-scoped) to localStorage + 7-day TTL — the
  // ageMs surfaced here drives the restored-banner copy.
  const restored = useRef<{ data: DraftState; ageMs: number } | null>(null);
  if (restored.current === null && typeof window !== "undefined") {
    restored.current = readDraft();
  }
  const draft = restored.current?.data ?? null;
  const draftAgeMs = restored.current?.ageMs ?? 0;
  // Sticky banner state: tells the user we restored a previous draft.
  // Hidden once they dismiss or discard — we don't tie it to draft
  // existence directly because the auto-save effect re-writes the draft
  // on every keystroke (so it'd never go away while typing).
  const [showRestoredBanner, setShowRestoredBanner] = useState(draft !== null);

  // ---- metadata form state -----------------------------------------
  const [slugRaw, setSlugRaw] = useState(draft?.slugRaw ?? "");
  const [authorRaw, setAuthorRaw] = useState(draft?.authorRaw ?? "");
  const [version, setVersion] = useState(draft?.version ?? "1.0.0");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [tagsInput, setTagsInput] = useState(draft?.tagsInput ?? "");
  const [connectorsInput, setConnectorsInput] = useState(
    draft?.connectorsInput ?? "",
  );
  const [license, setLicense] = useState(draft?.license ?? "MIT");
  const [homepage, setHomepage] = useState(draft?.homepage ?? "");
  const [riskLevel, setRiskLevel] = useState<RiskLevel>(
    draft?.riskLevel ?? "low",
  );
  const [networkAccess, setNetworkAccess] = useState(
    draft?.networkAccess ?? false,
  );
  const [fileAccess, setFileAccess] = useState(draft?.fileAccess ?? false);
  const [approvalBehavior, setApprovalBehavior] = useState<ApprovalBehavior>(
    draft?.approvalBehavior ?? "ask_on_novel",
  );

  // ---- yaml editor state -------------------------------------------
  const [yaml, setYaml] = useState(draft?.yaml ?? STARTER_RECIPE_YAML);

  // ---- lint state --------------------------------------------------
  const [lintResult, setLintResult] = useState<LintResult | null>(null);
  const [lintError, setLintError] = useState<string | null>(null);
  const [linting, setLinting] = useState(false);
  // #600: in-flight lint controller. Rapid clicks → stale response can
  // overwrite a newer result. Aborting the previous request before
  // firing a new one keeps the latest-click semantics intact.
  const lintAbortRef = useRef<AbortController | null>(null);

  // ---- starter recipes (load from bridge if running) ---------------
  const [installedNames, setInstalledNames] = useState<string[]>([]);
  const [bridgeOnline, setBridgeOnline] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(apiPath("/api/bridge/recipes"));
        if (!res.ok) {
          setBridgeOnline(false);
          return;
        }
        const data = await res.json();
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.recipes)
            ? data.recipes
            : [];
        setBridgeOnline(true);
        setInstalledNames(
          list
            .map((r: { name?: unknown }) =>
              typeof r?.name === "string" ? r.name : null,
            )
            .filter((n: string | null): n is string => n !== null),
        );
      } catch {
        setBridgeOnline(false);
      }
    })();
  }, []);

  // ---- submit / errors --------------------------------------------
  const [stage, setStage] = useState<Stage>(draft?.stage ?? "compose");
  const [submitErrors, setSubmitErrors] = useState<
    Partial<Record<keyof SubmissionFormData | "yaml", string>>
  >({});

  // ---- overwrite-confirm state ------------------------------------
  // When the user picks a preset or "load installed recipe" while the
  // YAML editor already holds non-trivial work, opening a confirm
  // Dialog avoids silently nuking that work. Pre-fix both onChange
  // handlers replaced the YAML directly. We only prompt when the
  // current YAML differs from the starter — typing a slug or
  // metadata doesn't trigger this, only actual YAML edits.
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    label: string;
    apply: () => void;
  } | null>(null);
  function yamlIsCustomized(): boolean {
    return yaml.trim() !== STARTER_RECIPE_YAML.trim();
  }

  // ---- derived data ------------------------------------------------
  const formData = useMemo<SubmissionFormData>(
    () => ({
      slug: normalizeSlug(slugRaw),
      author: normalizeAuthor(authorRaw),
      version: version.trim(),
      description,
      tags: tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      connectors: connectorsInput
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      license: license.trim() || "MIT",
      homepage: homepage.trim() || undefined,
      riskLevel,
      networkAccess,
      fileAccess,
      approvalBehavior,
    }),
    [
      slugRaw,
      authorRaw,
      version,
      description,
      tagsInput,
      connectorsInput,
      license,
      homepage,
      riskLevel,
      networkAccess,
      fileAccess,
      approvalBehavior,
    ],
  );

  const manifestContent = useMemo(
    () => buildManifestJson(formData),
    [formData],
  );

  // S2: live, non-blocking trust-consistency warnings. Computed
  // continuously (not just on submit) so the author sees a contradiction
  // — e.g. manifest says no-network but the YAML has an http step —
  // while composing, before the GitHub handoff. Conservative heuristics:
  // warn, never block. Returns [] when the YAML doesn't parse (the
  // submit-time syntax gate handles that case as a blocking error).
  const trustWarnings = useMemo<string[]>(() => {
    if (yaml.trim().length === 0) return [];
    try {
      return analyzeTrustConsistency(formData, yaml).map((i) => i.message);
    } catch {
      return [];
    }
  }, [formData, yaml]);

  // Live estimate of the full GitHub create-file URL we'd open at submit.
  // Lets the action bar warn the user before they hit the silent-truncation
  // ceiling (GitHub's prefill ~8 KB hard limit; we warn from URL_SAFE_CONTENT_LIMIT).
  const yamlUrlLength = useMemo(() => {
    try {
      return buildGithubCreateFileUrl({
        filename: recipeYamlPath(formData),
        content: yaml,
        message: `Add ${formData.slug || "(slug)"} recipe`,
        description: formData.description.trim(),
      }).length;
    } catch {
      return 0;
    }
  }, [formData, yaml]);

  // ---- auto-save draft to sessionStorage --------------------------
  // Debounced via useEffect re-fire — no per-keystroke setTimeout cleanup
  // dance needed, React batches the deps anyway. Only writes when at
  // least one field has user-entered content (avoids polluting storage
  // for users who land on the page and immediately leave).
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Always persist when stage === "submitted" so a refresh keeps the
    // user on the post-submit view (the "Open recipe.json on GitHub"
    // button lives there). Otherwise only persist when fields are dirty
    // — avoids polluting storage for users who land + leave immediately.
    const isDirty =
      stage === "submitted" ||
      slugRaw !== "" ||
      authorRaw !== "" ||
      description !== "" ||
      tagsInput !== "" ||
      connectorsInput !== "" ||
      homepage !== "" ||
      yaml !== STARTER_RECIPE_YAML;
    if (!isDirty) return;
    try {
      const snapshot: DraftState = {
        slugRaw,
        authorRaw,
        version,
        description,
        tagsInput,
        connectorsInput,
        license,
        homepage,
        riskLevel,
        networkAccess,
        fileAccess,
        approvalBehavior,
        yaml,
        stage,
      };
      // Wave 2: v2 envelope wraps the form state with a savedAt
      // timestamp so the restore path can compute draft age + TTL.
      window.localStorage.setItem(
        SUBMIT_DRAFT_STORAGE_KEY,
        JSON.stringify({ savedAt: Date.now(), data: snapshot }),
      );
    } catch {
      /* storage quota / disabled — non-fatal */
    }
  }, [
    slugRaw,
    authorRaw,
    version,
    description,
    tagsInput,
    connectorsInput,
    license,
    homepage,
    riskLevel,
    networkAccess,
    fileAccess,
    approvalBehavior,
    yaml,
    stage,
  ]);

  // ---- load starter from installed recipe --------------------------
  const loadFromInstalled = useCallback(
    async (name: string) => {
      if (!name) return;
      try {
        const res = await fetch(
          apiPath(`/api/bridge/recipes/${encodeURIComponent(name)}`),
        );
        if (!res.ok) {
          toast.error(`Couldn't load ${name}: HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { content?: string };
        if (typeof data.content !== "string" || data.content.length === 0) {
          toast.warn(`${name} returned no content.`);
          return;
        }
        setYaml(data.content);
        // Derive the slug from the YAML's own `name:` field rather than the
        // registry key — they often differ (registry uses @scope/slug, YAML
        // carries the unscoped slug). Only set if user hasn't typed one yet.
        if (!slugRaw) {
          const yamlName = extractYamlName(data.content);
          const fallback = name.replace(/^@[^/]+\//, "");
          setSlugRaw(yamlName ?? fallback);
        }
        // Extract description from a simple top-level `description: ...` line
        // so the user gets a head start. Skip if they've already typed one.
        if (!description) {
          const descMatch = /^description:\s*("([^"]+)"|'([^']+)'|(.+))$/m.exec(
            data.content,
          );
          const extracted =
            descMatch?.[2] ?? descMatch?.[3] ?? descMatch?.[4]?.trim();
          if (extracted) setDescription(extracted);
        }
        toast.success(`Loaded ${name} as starting point.`);
      } catch (err) {
        toast.error(
          `Couldn't load ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [description, slugRaw, toast],
  );

  // ---- validation --------------------------------------------------
  async function runLint() {
    // #600: cancel any in-flight lint before starting a new one so the
    // latest click always wins.
    lintAbortRef.current?.abort();
    const controller = new AbortController();
    lintAbortRef.current = controller;
    setLinting(true);
    setLintError(null);
    try {
      const res = await fetch(apiPath("/api/bridge/recipes/lint"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: yaml }),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          setLintError(
            "Bridge isn't responding — syntax validated only. You can still submit (YAML syntax is checked client-side; full schema validation runs during PR review).",
          );
          return;
        }
        // Any other non-OK status (e.g. 401 on a gated/public deploy)
        // degrades to syntax-only too — never a full bypass: the
        // client-side YAML syntax gate in validateSubmission still runs
        // at submit time.
        setLintError(
          `Validation request failed: HTTP ${res.status} — syntax validated only. Full schema validation runs during PR review.`,
        );
        return;
      }
      const data = (await res.json()) as {
        errors?: unknown;
        warnings?: unknown;
      };
      // `/recipes/lint` now returns LintIssue[]. Accept both shapes during
      // the transition so submit page doesn't break against an older bridge.
      const toMessage = (raw: unknown): string | null => {
        if (typeof raw === "string") return raw;
        if (
          raw &&
          typeof raw === "object" &&
          typeof (raw as { message?: unknown }).message === "string"
        ) {
          return (raw as { message: string }).message;
        }
        return null;
      };
      const errors = Array.isArray(data.errors)
        ? data.errors.map(toMessage).filter((m): m is string => m !== null)
        : [];
      const warnings = Array.isArray(data.warnings)
        ? data.warnings.map(toMessage).filter((m): m is string => m !== null)
        : [];
      setLintResult({ forContent: yaml, errors, warnings });
      if (errors.length === 0 && warnings.length === 0) {
        toast.success("Recipe YAML is valid.");
      } else if (errors.length === 0) {
        toast.info(
          `Valid — ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
        );
      } else {
        toast.error(
          `${errors.length} error${errors.length === 1 ? "" : "s"} — fix before submitting.`,
        );
      }
    } catch (err) {
      // Aborts from a newer click are expected — don't surface them.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLintError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only clear the loading flag if THIS controller is still the
      // current one — a newer click already kicked off and will manage
      // its own setLinting(false).
      if (lintAbortRef.current === controller) {
        setLinting(false);
        lintAbortRef.current = null;
      }
    }
  }

  // ---- submit ------------------------------------------------------
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // S2: pass the YAML so validateSubmission runs the client-side syntax
    // gate (blocking) + trust-consistency heuristics (non-blocking). The
    // syntax gate is independent of the bridge lint endpoint, so broken
    // YAML can't slip through even when the bridge is offline / gated.
    const issues = validateSubmission(formData, yaml);
    const errMap: Partial<Record<keyof SubmissionFormData | "yaml", string>> =
      {};
    for (const issue of issues) {
      // Trust-consistency warnings are non-blocking — they're surfaced
      // live via the trustWarnings memo, not as submit-blocking errors.
      if (issue.level === "warning") continue;
      // Only record the first blocking issue per field; the UI shows one
      // line each.
      if (!errMap[issue.field]) errMap[issue.field] = issue.message;
    }
    if (yaml.trim().length === 0) {
      errMap.yaml = "Recipe YAML is required.";
    } else if (!errMap.yaml) {
      // Cross-check the YAML's `name:` against the form slug. They land in
      // separate files (recipe.yaml + recipe.json) so a mismatch would mean
      // the index builder shows one name but the YAML asserts another.
      // Skip if the syntax gate already flagged this field.
      const yamlName = extractYamlName(yaml);
      if (yamlName !== null && yamlName !== formData.slug) {
        errMap.yaml = `YAML "name: ${yamlName}" doesn't match the slug "${formData.slug}". They must match — update one or the other.`;
      }
    }
    setSubmitErrors(errMap);

    if (Object.keys(errMap).length > 0) {
      toast.error("Please fix the errors before submitting.");
      return;
    }
    // Validate-before-submit guard. Pre-fix the submit handler accepted
    // a null lintResult (user never clicked Validate) and forwarded the
    // YAML straight to the GitHub create-file page — meaning a recipe
    // with a syntax error could land in the PR with no warning. Now
    // require either a fresh successful Validate OR a recorded bridge-
    // unreachable lintError (the user opted into the soft-validate path
    // explicitly by attempting Validate).
    const lintIsFresh =
      lintResult !== null && lintResult.forContent === yaml;
    if (lintIsFresh && lintResult.errors.length > 0) {
      toast.error("Fix lint errors before submitting.");
      return;
    }
    if (!lintIsFresh && lintError === null) {
      // Wave 2: the previous "Click Validate first" message was a dead
      // end when the bridge was offline — users would click Validate,
      // get a fast error, but the soft-bypass path (`lintError !==
      // null`) wasn't obvious. Spell it out: clicking Validate ALWAYS
      // unblocks submit, whether the bridge accepts the lint or
      // reports unreachable.
      errMap.yaml =
        "Click Validate to lint the YAML. If the bridge is offline, " +
        "Validate will surface that immediately and let you proceed " +
        "(full validation runs server-side during PR review).";
      setSubmitErrors(errMap);
      toast.error("Click Validate before submitting.");
      return;
    }

    const yamlUrl = buildGithubCreateFileUrl({
      filename: recipeYamlPath(formData),
      content: yaml,
      message: `Add ${formData.slug} recipe`,
      description: formData.description.trim(),
    });

    // Warn FIRST when oversized so the user reads it before landing on the
    // potentially-truncated GitHub page. Measure the full URL, not just YAML
    // length — percent-encoded description + message also count against the
    // browser/GitHub URL budget.
    if (yamlUrl.length > URL_SAFE_CONTENT_LIMIT) {
      toast.warn(
        "Recipe is large — if GitHub doesn't pre-fill, paste the YAML manually using the copy button on the next screen.",
        { duration: 10_000 },
      );
    }

    const win = window.open(yamlUrl, "_blank", "noopener,noreferrer");
    if (win === null) {
      // Popup blocker engaged. Surface the URL so the user can still proceed
      // — copying it manually is the standard escape hatch.
      toast.error(
        "Popup blocked. Open recipe.yaml on GitHub from the next screen instead.",
        { duration: 8000 },
      );
    }
    setStage("submitted");
  }

  function openManifestTab() {
    const url = buildGithubCreateFileUrl({
      filename: recipeJsonPath(formData),
      content: manifestContent,
      message: `Add ${formData.slug} manifest`,
    });
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (win === null) {
      toast.error(
        "Popup blocked. Use the copyable manifest block below and create the file on GitHub manually.",
        { duration: 8000 },
      );
    }
  }

  // Reset every form field + transient state to its initial value, then
  // drop the persisted draft. Stage stays the caller's responsibility
  // (Start Over goes to "compose"; nobody else uses this currently).
  function resetToDefaults() {
    setSlugRaw("");
    setAuthorRaw("");
    setVersion("1.0.0");
    setDescription("");
    setTagsInput("");
    setConnectorsInput("");
    setLicense("MIT");
    setHomepage("");
    setRiskLevel("low");
    setNetworkAccess(false);
    setFileAccess(false);
    setApprovalBehavior("ask_on_novel");
    setYaml(STARTER_RECIPE_YAML);
    setLintResult(null);
    setLintError(null);
    setSubmitErrors({});
    clearDraft();
  }

  function startOver() {
    // After submit, "Start over" should produce a fresh form. Pre-PR550-
    // followup this only flipped stage + cleared transient errors and
    // called clearDraft — but now that `stage` is in the auto-save
    // effect's deps, the very next render would re-save the still-
    // populated fields, defeating the clear. Wipe the fields too.
    resetToDefaults();
    setStage("compose");
  }

  function applyPreset(presetId: string) {
    const preset = RECIPE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const doApply = () => {
      // Only swap the YAML; metadata fields the user already filled stay
      // intact. Lint result becomes stale by virtue of forContent mismatch.
      setYaml(preset.yaml);
      toast.info(`Loaded the ${preset.label} preset.`);
    };
    if (yamlIsCustomized()) {
      setPendingOverwrite({
        label: `the “${preset.label}” preset`,
        apply: doApply,
      });
      return;
    }
    doApply();
  }

  function discardRestoredDraft() {
    resetToDefaults();
    setShowRestoredBanner(false);
    toast.info("Draft discarded — starting fresh.");
  }

  // -----------------------------------------------------------------
  // SUBMITTED VIEW — instructions for finishing the PR
  // -----------------------------------------------------------------
  if (stage === "submitted") {
    return (
      <SubmittedView
        formData={formData}
        yaml={yaml}
        manifestContent={manifestContent}
        onOpenManifestTab={openManifestTab}
        onStartOver={startOver}
      />
    );
  }

  // -----------------------------------------------------------------
  // COMPOSE VIEW — main form
  // -----------------------------------------------------------------
  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            Submit a recipe
          </h1>
          <div className="editorial-sub">
            Publishes to{" "}
            <code>
              github.com/{REGISTRY_OWNER}/{REGISTRY_REPO}
            </code>{" "}
            via GitHub&apos;s web flow — auto-forks if you don&apos;t have push access.
            No backend, no extra accounts.
          </div>
        </div>
        <Link
          href="/marketplace"
          className="btn sm ghost"
          style={{ textDecoration: "none", fontSize: "var(--fs-s)" }}
        >
          ← Back to marketplace
        </Link>
      </div>

      <div
        role="note"
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--r-2)",
          color: "var(--ink-2)",
          fontSize: "var(--fs-s)",
          marginBottom: "var(--s-5)",
          padding: "var(--s-3) var(--s-4)",
        }}
      >
        <strong style={{ color: "var(--ink-1)" }}>How this works:</strong> fill
        the form below, validate the YAML, then click{" "}
        <strong>Open PR on GitHub</strong>. We open a prefilled &quot;create new
        file&quot; page on the registry repo. GitHub will fork it for you if
        needed, then you click <em>Propose new file</em> to open a PR. You
        then add the manifest file the same way — full instructions appear on
        the next screen.
      </div>

      {showRestoredBanner && (
        <div
          role="status"
          style={{
            alignItems: "center",
            background: "var(--info-soft, var(--bg-1))",
            border: "1px solid var(--info, var(--border-default))",
            borderRadius: "var(--r-2)",
            color: "var(--ink-1)",
            display: "flex",
            fontSize: "var(--fs-s)",
            gap: "var(--s-3)",
            justifyContent: "space-between",
            marginBottom: "var(--s-5)",
            padding: "var(--s-3) var(--s-4)",
          }}
        >
          <span>
            <strong>Draft restored</strong> from {fmtDraftAge(draftAgeMs)}.
            Drafts auto-discard after 7 days.
          </span>
          <span style={{ display: "flex", gap: "var(--s-2)" }}>
            <button
              type="button"
              className="btn sm ghost"
              onClick={discardRestoredDraft}
              style={{ fontSize: "var(--fs-xs)" }}
            >
              Discard and start fresh
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => setShowRestoredBanner(false)}
              aria-label="Dismiss the draft-restored banner"
              style={{ fontSize: "var(--fs-xs)" }}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-2)",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "var(--s-3)",
          marginBottom: "var(--s-5)",
          padding: "var(--s-3) var(--s-4)",
          fontSize: "var(--fs-s)",
        }}
      >
        <span style={{ color: "var(--ink-2)" }}>Start from:</span>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            color: "var(--ink-2)",
          }}
        >
          <span style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>
            preset
          </span>
          <select
            defaultValue=""
            onChange={(e) => {
              applyPreset(e.target.value);
              e.currentTarget.value = "";
            }}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--r-2)",
              color: "var(--ink-0)",
              fontSize: "var(--fs-s)",
              padding: "var(--s-1) var(--s-2)",
            }}
            aria-label="Load a starter recipe preset"
          >
            <option value="">— pick a preset —</option>
            {RECIPE_PRESETS.map((p) => (
              <option key={p.id} value={p.id} title={p.description}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {bridgeOnline && installedNames.length > 0 && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              color: "var(--ink-2)",
            }}
          >
            <span style={{ color: "var(--ink-3)", fontSize: "var(--fs-xs)" }}>
              installed recipe
            </span>
            <select
              defaultValue=""
              onChange={(e) => {
                const picked = e.target.value;
                e.currentTarget.value = "";
                if (!picked) return;
                if (yamlIsCustomized()) {
                  setPendingOverwrite({
                    label: `“${picked}” (installed recipe)`,
                    apply: () => void loadFromInstalled(picked),
                  });
                  return;
                }
                void loadFromInstalled(picked);
              }}
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--r-2)",
                color: "var(--ink-0)",
                fontSize: "var(--fs-s)",
                padding: "var(--s-1) var(--s-2)",
              }}
              aria-label="Load an installed recipe as a starting point"
            >
              <option value="">— pick a recipe —</option>
              {installedNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: "var(--s-6)",
        }}
        className="recipe-submit-layout"
      >
        {/* -------- LEFT: metadata fields ------------------------- */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--s-5)",
          }}
        >
          <FieldGroup title="Identity">
            <FormField
              label="Slug"
              htmlFor="ms-slug"
              required
              hint={
                // Three states: warn if the raw input normalised to something
                // different (unicode/uppercase/whitespace stripped), preview the
                // resulting path once it's clean, or show the initial how-to copy.
                slugRaw && slugRaw.trim() !== formData.slug
                  ? `Will be saved as “${formData.slug || "(empty)"}” — only lowercase letters, digits, and hyphens are allowed.`
                  : formData.slug
                    ? `Becomes ${recipeYamlPath(formData)} on GitHub.`
                    : "Lowercase kebab-case (e.g. my-daily-report). Becomes the directory name in the registry."
              }
              error={submitErrors.slug}
            >
              <input
                id="ms-slug"
                type="text"
                value={slugRaw}
                onChange={(e) => setSlugRaw(e.target.value)}
                placeholder="my-daily-report"
                style={inputStyle(!!submitErrors.slug)}
              />
            </FormField>

            <FormField
              label="Author handle"
              htmlFor="ms-author"
              required
              hint="Your GitHub username (without @). Shown in the marketplace."
              error={submitErrors.author}
            >
              <input
                id="ms-author"
                type="text"
                value={authorRaw}
                onChange={(e) => setAuthorRaw(e.target.value)}
                placeholder="myhandle"
                style={inputStyle(!!submitErrors.author)}
              />
            </FormField>

            <FormField
              label="Version"
              htmlFor="ms-version"
              required
              hint="Semver (e.g. 1.0.0)."
              error={submitErrors.version}
            >
              <input
                id="ms-version"
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                style={inputStyle(!!submitErrors.version)}
              />
            </FormField>
          </FieldGroup>

          <FieldGroup title="Description & taxonomy">
            <FormField
              label="Description"
              htmlFor="ms-desc"
              required
              hint={`${280 - description.length} chars remaining.`}
              error={submitErrors.description}
            >
              <AutoGrowTextarea
                id="ms-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line summary of what this recipe does."
                rows={2}
                maxLength={280}
                maxHeight={240}
                style={{
                  ...inputStyle(!!submitErrors.description),
                  fontFamily: "var(--font-sans)",
                }}
              />
            </FormField>

            <FormField
              label="Tags"
              htmlFor="ms-tags"
              required
              hint="Comma-separated. e.g. productivity, daily, slack."
              error={submitErrors.tags}
            >
              <input
                id="ms-tags"
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="productivity, daily"
                style={inputStyle(!!submitErrors.tags)}
              />
            </FormField>

            <FormField
              label="Connectors"
              htmlFor="ms-connectors"
              hint="Comma-separated connector ids the recipe uses. e.g. gmail, slack, linear."
            >
              <input
                id="ms-connectors"
                type="text"
                value={connectorsInput}
                onChange={(e) => setConnectorsInput(e.target.value)}
                placeholder="gmail, slack"
                style={inputStyle(false)}
              />
            </FormField>

            <FormField label="License" htmlFor="ms-license">
              <input
                id="ms-license"
                type="text"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                placeholder="MIT"
                style={inputStyle(false)}
              />
            </FormField>

            <FormField
              label="Homepage"
              htmlFor="ms-homepage"
              hint="Optional URL with docs or screenshots."
              error={submitErrors.homepage}
            >
              <input
                id="ms-homepage"
                type="url"
                value={homepage}
                onChange={(e) => setHomepage(e.target.value)}
                placeholder="https://example.com/my-recipe"
                style={inputStyle(!!submitErrors.homepage)}
              />
            </FormField>
          </FieldGroup>

          <FieldGroup title="Trust metadata">
            <FormField
              label="Risk level"
              htmlFor="ms-risk"
              hint="High-risk recipes are gated behind a confirmation dialog."
            >
              <select
                id="ms-risk"
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value as RiskLevel)}
                style={inputStyle(false)}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </FormField>

            <FormField label="Approval behavior" htmlFor="ms-approval">
              <select
                id="ms-approval"
                value={approvalBehavior}
                onChange={(e) =>
                  setApprovalBehavior(e.target.value as ApprovalBehavior)
                }
                style={inputStyle(false)}
              >
                <option value="always_ask">always_ask</option>
                <option value="ask_on_novel">ask_on_novel</option>
                <option value="auto_approve">auto_approve</option>
              </select>
            </FormField>

            <div
              style={{
                display: "flex",
                gap: "var(--s-4)",
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-2)",
                  fontSize: "var(--fs-s)",
                  color: "var(--ink-2)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={networkAccess}
                  onChange={(e) => setNetworkAccess(e.target.checked)}
                />
                Makes outbound network requests
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-2)",
                  fontSize: "var(--fs-s)",
                  color: "var(--ink-2)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={fileAccess}
                  onChange={(e) => setFileAccess(e.target.checked)}
                />
                Reads or writes local files
              </label>
            </div>
          </FieldGroup>
        </div>

        {/* -------- RIGHT: YAML editor + lint --------------------- */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--s-3)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--s-2)",
            }}
          >
            <span
              id="ms-yaml-label"
              style={{
                fontSize: "var(--fs-m)",
                fontWeight: 500,
                color: "var(--ink-1)",
              }}
            >
              Recipe YAML <span style={{ color: "var(--err)" }}>*</span>
            </span>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => void runLint()}
              disabled={linting}
              style={{ fontSize: "var(--fs-s)" }}
            >
              {linting ? "Validating…" : "Validate"}
            </button>
          </div>
          <div aria-labelledby="ms-yaml-label">
            <YamlEditor value={yaml} onChange={setYaml} minHeight={500} />
          </div>
          {submitErrors.yaml && (
            <div className="alert-err" role="alert">
              {submitErrors.yaml}
            </div>
          )}
          {lintError && (
            <div
              role="alert"
              style={{
                background: "var(--warn-soft, var(--bg-2))",
                border: "1px solid var(--warn, var(--border-default))",
                borderRadius: "var(--r-2)",
                color: "var(--warn, var(--ink-1))",
                fontSize: "var(--fs-s)",
                padding: "var(--s-2) var(--s-3)",
              }}
            >
              {lintError}
            </div>
          )}
          {lintResult &&
            lintResult.forContent === yaml &&
            lintResult.errors.length === 0 && (
              <div
                role="status"
                style={{
                  alignItems: "center",
                  background: "var(--ok-soft, var(--bg-2))",
                  border: "1px solid var(--ok, var(--border-default))",
                  borderRadius: "var(--r-2)",
                  color: "var(--ok, var(--ink-1))",
                  display: "flex",
                  fontSize: "var(--fs-s)",
                  gap: "var(--s-2)",
                  padding: "var(--s-2) var(--s-3)",
                }}
              >
                <span aria-hidden="true">✓</span>
                <span>
                  Lint passed
                  {lintResult.warnings.length > 0 &&
                    ` — ${lintResult.warnings.length} warning${lintResult.warnings.length === 1 ? "" : "s"} below`}
                </span>
              </div>
            )}
          {lintResult && lintResult.forContent !== yaml && (
            <div
              role="status"
              style={{
                color: "var(--ink-3)",
                fontSize: "var(--fs-xs)",
                fontStyle: "italic",
              }}
            >
              YAML edited since last validation — click Validate again.
            </div>
          )}
          {lintResult && lintResult.forContent === yaml &&
            lintResult.errors.length > 0 && (
            <div className="alert-err" role="alert">
              <strong>
                {lintResult.errors.length} error
                {lintResult.errors.length === 1 ? "" : "s"}:
              </strong>
              <ul style={{ margin: "var(--s-2) 0 0 var(--s-4)" }}>
                {lintResult.errors.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lint output can repeat the same string on multiple lines
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {lintResult && lintResult.forContent === yaml &&
            lintResult.warnings.length > 0 && (
            <details
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--r-2)",
                fontSize: "var(--fs-s)",
                padding: "var(--s-2) var(--s-3)",
              }}
            >
              <summary style={{ color: "var(--warn)", cursor: "pointer" }}>
                {lintResult.warnings.length} warning
                {lintResult.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul
                style={{
                  margin: "var(--s-2) 0 0 var(--s-4)",
                  color: "var(--ink-2)",
                }}
              >
                {lintResult.warnings.map((w, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lint output can repeat the same string on multiple lines
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        {/* -------- manifest preview (spans both grid columns) ---- */}
        <details
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--r-2)",
            fontSize: "var(--fs-s)",
            gridColumn: "1 / -1",
            padding: "var(--s-2) var(--s-3)",
          }}
        >
          <summary
            style={{ color: "var(--ink-2)", cursor: "pointer" }}
            aria-label="Toggle the manifest preview"
          >
            Preview <code>recipe.json</code> — the manifest that will be
            committed alongside the YAML
          </summary>
          <pre
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--r-2)",
              color: "var(--ink-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-s)",
              margin: "var(--s-2) 0 0",
              maxHeight: 280,
              overflow: "auto",
              padding: "var(--s-3) var(--s-4)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {manifestContent}
          </pre>
        </details>

        {/* -------- trust-consistency warnings (S2, non-blocking) - */}
        {trustWarnings.length > 0 && (
          <div
            role="status"
            style={{
              background: "var(--warn-soft, var(--bg-2))",
              border: "1px solid var(--warn, var(--border-default))",
              borderRadius: "var(--r-2)",
              color: "var(--ink-1)",
              fontSize: "var(--fs-s)",
              gridColumn: "1 / -1",
              padding: "var(--s-3) var(--s-4)",
            }}
          >
            <strong style={{ color: "var(--warn)" }}>
              {trustWarnings.length} trust-metadata warning
              {trustWarnings.length === 1 ? "" : "s"}
            </strong>{" "}
            — these don&apos;t block submission, but reviewers will likely
            flag them:
            <ul style={{ margin: "var(--s-2) 0 0 var(--s-4)" }}>
              {trustWarnings.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warnings are plain strings, order-stable
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* -------- action bar (inside form so Enter submits) ----- */}
        <div
          style={{
            display: "flex",
            gap: "var(--s-3)",
            alignItems: "center",
            // flex-wrap so the URL-size readout drops below the buttons on
            // narrow viewports instead of squeezing into them. Without
            // this the readout text gets clipped or overlaps the Cancel
            // link on phones.
            flexWrap: "wrap",
            marginTop: "var(--s-6)",
            gridColumn: "1 / -1",
          }}
        >
          <button type="submit" className="btn primary">
            Open PR on GitHub →
          </button>
          <Link href="/marketplace" className="btn ghost">
            Cancel
          </Link>
          <div
            style={{
              color: "var(--ink-3)",
              fontSize: "var(--fs-s)",
              // `marginLeft: auto` pushes the readout to the right edge on
              // wide rows AND keeps it left-aligned on its own row after
              // wrap (the parent's `gap` already provides vertical spacing).
              marginLeft: "auto",
              textAlign: "right",
              lineHeight: 1.4,
              // Block stays full-width on small viewports so the "URL ≈ X KB"
              // line doesn't get hyphenated awkwardly. Cap so on desktop it
              // doesn't grow past content.
              minWidth: 0,
            }}
          >
            <div>
              Will open PR against{" "}
              <code>
                {REGISTRY_OWNER}/{REGISTRY_REPO}@{REGISTRY_BRANCH}
              </code>
            </div>
            <div
              style={{
                color:
                  yamlUrlLength > URL_SAFE_CONTENT_LIMIT
                    ? "var(--warn)"
                    : "var(--ink-3)",
                fontSize: "var(--fs-xs)",
              }}
              title={
                yamlUrlLength > URL_SAFE_CONTENT_LIMIT
                  ? "URL is past the safe limit — GitHub may silently truncate the prefill. Use the manifest copy block as backup."
                  : "Approximate URL byte length GitHub will receive."
              }
            >
              URL ≈ {(yamlUrlLength / 1024).toFixed(1)} KB
              {yamlUrlLength > URL_SAFE_CONTENT_LIMIT && " ⚠"}
            </div>
          </div>
        </div>
      </form>


      <Dialog
        open={pendingOverwrite !== null}
        onClose={() => setPendingOverwrite(null)}
        ariaLabel="Confirm overwrite of in-progress recipe YAML"
      >
        <h2
          style={{
            margin: 0,
            marginBottom: "var(--s-3)",
            fontSize: "var(--fs-l)",
            color: "var(--ink-0)",
          }}
        >
          Replace current YAML?
        </h2>
        <p
          style={{
            margin: 0,
            marginBottom: "var(--s-5)",
            fontSize: "var(--fs-s)",
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          You&apos;ve edited the recipe YAML. Loading {pendingOverwrite?.label}{" "}
          will overwrite your work. Metadata fields (slug, author, tags…)
          stay as-is.
        </p>
        <div
          style={{
            display: "flex",
            gap: "var(--s-2)",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setPendingOverwrite(null)}
          >
            Keep my YAML
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              const apply = pendingOverwrite?.apply;
              setPendingOverwrite(null);
              apply?.();
            }}
            // biome-ignore lint/a11y/noAutofocus: dialog-scoped — Enter
            // should perform the primary (destructive) action explicitly.
            autoFocus
          >
            Replace YAML
          </button>
        </div>
      </Dialog>
    </section>
  );
}

// =====================================================================
// SubmittedView — instructions for finishing the PR
// =====================================================================
function SubmittedView({
  formData,
  yaml,
  manifestContent,
  onOpenManifestTab,
  onStartOver,
}: {
  formData: SubmissionFormData;
  yaml: string;
  manifestContent: string;
  onOpenManifestTab: () => void;
  onStartOver: () => void;
}) {
  return (
    <section>
      <div className="page-head">
        <div>
          <h1 className="editorial-h1" style={{ margin: 0 }}>
            Recipe submission in progress
          </h1>
          <div className="editorial-sub">
            We opened GitHub in a new tab with{" "}
            <code>{recipeYamlPath(formData)}</code> prefilled. Two more steps
            and you&apos;re done.
          </div>
        </div>
      </div>

      <ol
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--r-3)",
          fontSize: "var(--fs-m)",
          listStyle: "decimal inside",
          margin: 0,
          marginBottom: "var(--s-5)",
          padding: "var(--s-4) var(--s-5)",
        }}
      >
        <li style={{ marginBottom: "var(--s-3)" }}>
          <strong>On GitHub:</strong> click <em>Propose new file</em> (GitHub
          will fork for you if needed), then <em>Create pull request</em>.
        </li>
        <li style={{ marginBottom: "var(--s-3)" }}>
          <strong>Add the manifest:</strong> click the button below to open a
          second GitHub tab prefilled with{" "}
          <code>{recipeJsonPath(formData)}</code>.{" "}
          <strong style={{ color: "var(--err)" }}>
            Commit it to the SAME branch you used in step 1
          </strong>
          {" "}— GitHub may default to a new branch like{" "}
          <code>patch-2</code>; use the branch dropdown at the top of the
          editor to switch to step-1&apos;s branch (typically{" "}
          <code>patch-1</code>). Two different branches means two separate
          PRs, neither one complete.
        </li>
        <li>
          <strong>Done:</strong> reload your PR — both files will appear.
          Maintainers review, and once merged the recipe shows up in the
          marketplace via the auto-generated index.json.
        </li>
      </ol>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-2)",
          marginBottom: "var(--s-6)",
        }}
      >
        <div
          style={{
            background: "var(--warn-soft)",
            border: "1px solid var(--warn)",
            borderRadius: "var(--r-2)",
            color: "var(--ink-1)",
            fontSize: "var(--fs-s)",
            padding: "var(--s-2) var(--s-3)",
          }}
        >
          <strong>Branch check:</strong> before clicking Commit on the next
          tab, confirm the branch dropdown at the top of GitHub&apos;s editor
          reads the SAME branch you committed step 1 to. Both files must
          land on one branch for the PR to be complete.
        </div>
        <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            onClick={onOpenManifestTab}
          >
            Open recipe.json on GitHub →
          </button>
          <button type="button" className="btn ghost" onClick={onStartOver}>
            ← Start over
          </button>
        </div>
      </div>

      <SubmissionSummary
        formData={formData}
        yaml={yaml}
        manifestContent={manifestContent}
      />
    </section>
  );
}

function SubmissionSummary({
  formData,
  yaml,
  manifestContent,
}: {
  formData: SubmissionFormData;
  yaml: string;
  manifestContent: string;
}) {
  return (
    <>
      <h2
        style={{
          fontSize: "var(--fs-m)",
          fontWeight: 600,
          color: "var(--ink-2)",
          marginBottom: "var(--s-3)",
        }}
      >
        Submission summary
      </h2>
      <dl
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--r-3)",
          fontSize: "var(--fs-s)",
          padding: "var(--s-4)",
          marginBottom: "var(--s-5)",
        }}
      >
        <SummaryRow label="Marketplace name" value={`@${formData.author}/${formData.slug}`} />
        <SummaryRow label="Install source" value={installSourceFor(formData)} />
        <SummaryRow label="Version" value={formData.version} />
        <SummaryRow label="Risk level" value={formData.riskLevel} />
        <SummaryRow
          label="Tags"
          value={formData.tags.length > 0 ? formData.tags.join(", ") : "—"}
        />
        <SummaryRow
          label="Connectors"
          value={
            formData.connectors.length > 0
              ? formData.connectors.join(", ")
              : "—"
          }
        />
      </dl>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: "var(--s-5)",
        }}
      >
        <CopyableBlock label="recipe.yaml" content={yaml} />
        <CopyableBlock label="recipe.json (manifest)" content={manifestContent} />
      </div>
    </>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: "var(--s-3)",
        padding: "var(--s-1) 0",
      }}
    >
      <dt style={{ color: "var(--ink-3)", fontWeight: 500 }}>{label}</dt>
      <dd
        style={{
          color: "var(--ink-1)",
          fontFamily: "var(--font-mono)",
          margin: 0,
          wordBreak: "break-word",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function CopyableBlock({
  label,
  content,
}: {
  label: string;
  content: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(copyTimerRef.current); }, []);
  function onCopy() {
    setCopyError(null);
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
      })
      .catch((err: unknown) => {
        // Permission denied / insecure context — clipboard is gated on https.
        // Surface the failure so the user can fall back to manual selection.
        setCopyError(
          err instanceof Error
            ? err.message
            : "Couldn't write to the clipboard.",
        );
      });
  }
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--s-2)",
        }}
      >
        <span
          style={{
            color: "var(--ink-2)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-s)",
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="btn sm ghost"
          style={{ fontSize: "var(--fs-xs)" }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      {copyError && (
        <div
          role="alert"
          style={{
            color: "var(--err)",
            fontSize: "var(--fs-xs)",
            marginBottom: "var(--s-1)",
          }}
        >
          {copyError} Select the block below and copy manually.
        </div>
      )}
      <pre
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--r-2)",
          color: "var(--ink-1)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-s)",
          margin: 0,
          maxHeight: 320,
          overflow: "auto",
          padding: "var(--s-3) var(--s-4)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {content}
      </pre>
    </div>
  );
}

// =====================================================================
// Small presentational helpers
// =====================================================================

function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          color: "var(--ink-2)",
          fontSize: "var(--fs-s)",
          fontWeight: 500,
          marginBottom: "var(--s-3)",
        }}
      >
        {title}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-4)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function FormField({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactElement<{
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>;
}) {
  const msgId = `${htmlFor}-msg`;
  const messageShown = error || hint;
  const childWithAria = cloneElement(children, {
    "aria-describedby": messageShown ? msgId : undefined,
    "aria-invalid": error ? true : undefined,
  });
  return (
    <div>
      <label
        htmlFor={htmlFor}
        style={{
          display: "block",
          marginBottom: "var(--s-2)",
          color: "var(--ink-1)",
          fontSize: "var(--fs-m)",
          fontWeight: 500,
        }}
      >
        {label} {required && <span style={{ color: "var(--err)" }}>*</span>}
      </label>
      {childWithAria}
      {error ? (
        <div
          id={msgId}
          role="alert"
          style={{
            color: "var(--err)",
            fontSize: "var(--fs-s)",
            marginTop: "var(--s-1)",
          }}
        >
          {error}
        </div>
      ) : (
        hint && (
          <div
            id={msgId}
            style={{
              color: "var(--ink-3)",
              fontSize: "var(--fs-s)",
              marginTop: "var(--s-1)",
            }}
          >
            {hint}
          </div>
        )
      )}
    </div>
  );
}

// Hoisted style objects — there are only two variants, so we can avoid
// allocating per render. React shallow-diffs style props, so reusing the
// same object reference skips the inline-style write entirely on rerender.
const INPUT_STYLE_BASE: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--r-2)",
  color: "var(--ink-0)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-base)",
  outline: "none",
  padding: "var(--s-2) var(--s-3)",
};
const INPUT_STYLE_ERROR: React.CSSProperties = {
  ...INPUT_STYLE_BASE,
  border: "1px solid var(--err)",
};

function inputStyle(hasError: boolean): React.CSSProperties {
  return hasError ? INPUT_STYLE_ERROR : INPUT_STYLE_BASE;
}
