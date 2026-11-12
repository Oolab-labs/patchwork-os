/**
 * Guard: nothing in production queues an approval without announcing it.
 *
 * There are two ways to put an approval in front of a person:
 *
 *   - `enqueueApprovalWithDispatch` (approvalHttp.ts) queues AND announces it
 *     on every configured channel — webhook, Web Push, ntfy.
 *   - `ApprovalQueue.request()` queues, and tells nobody.
 *
 * Calling the second from a path that needs a person is a defect with the
 * worst kind of symptom: the run or tool call halts, nobody is asked, the
 * approval expires, and the work fails looking exactly like something that
 * broke. It has been found and fixed FOUR times, on four different callers,
 * each fix reaching the callers someone thought of:
 *
 *   1. the CLI PreToolUse gate          (WebSocket `tools/call`, bridge.ts)
 *   2. the recipe tier gate             (`makeRecipeApprovalFn`, 2026-08-28)
 *   3. the worker gate                  (`buildWorkerAutonomyGate`, 2026-11-12)
 *   4. the Streamable HTTP gate         (`tools/call` over /mcp, 2026-11-12)
 *
 * Four is enough to stop fixing callers and fix the rule. The rule: there is
 * exactly ONE production use of the queue's `request`, and it is the one
 * inside `enqueueApprovalWithDispatch`. This file fails when a second
 * appears, whatever it is called and however it is reached.
 *
 * ── How it looks ──────────────────────────────────────────────────────────
 * Source-level, like the repo's other guards, but on the PARSED source rather
 * than on text: a regex over text is fooled by a comment or a string that
 * mentions `queue.request(` (approvalHttp.ts has two such comments), and
 * misses `queue["request"]`, a chained call split across lines, a
 * destructured `const { request } = queue`, or `queue.request` passed as a
 * value. The TypeScript parser — a devDependency, parse only, no type
 * checking — makes those distinctions for free.
 *
 * Two nets, because either alone has a hole:
 *
 *   A. Anywhere in production: no use of `.request` on a receiver that names
 *      a queue (`queue`, `deps.queue`, `this.approvalQueue`,
 *      `getApprovalQueue()`).
 *   B. In any file that can hold an approval queue at all (it names
 *      `getApprovalQueue`, `ApprovalQueue`, `ApprovalNotifyDeps` or
 *      `ApprovalHttpDeps`): no use of `.request` on ANY receiver. This is
 *      what catches `const q = getApprovalQueue(); q.request(…)`, where the
 *      receiver's name says nothing.
 *
 * ── What it cannot see ────────────────────────────────────────────────────
 * It is syntactic, not type-aware. A queue obtained in a file that names none
 * of those four identifiers, AND held under a name without "queue" in it,
 * passes both nets — for example a new accessor on some other class that
 * hands the queue out. Closing that needs a type-checked program per run,
 * which costs tens of seconds on a suite whose slowest CI cell has little to
 * spare; the behavioural tests (`workerGateApprovalNotifies`,
 * `streamableHttpApprovalNotifies`) are what cover a path once it exists.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one place production may use the queue's `request`. */
const ALLOWED = {
  file: "approvalHttp.ts",
  fn: "enqueueApprovalWithDispatch",
} as const;

/** A file naming any of these can be holding an approval queue. */
const QUEUE_HOLDER =
  /\b(getApprovalQueue|ApprovalQueue|ApprovalNotifyDeps|ApprovalHttpDeps)\b/;

/**
 * Uses of some OTHER object's `.request` inside a queue-holding file (net B
 * cannot tell them apart by itself). Empty today: none of those files calls
 * any other `request`.
 *
 * To add one: name the file (relative to src/, forward slashes), the exact
 * receiver text, and why it is not an approval queue. An entry that no longer
 * matches anything fails the last test in this file — a stale exemption is a
 * hole waiting for a use.
 */
const NOT_A_QUEUE: ReadonlyArray<{
  file: string;
  receiver: string;
  why: string;
}> = [];

interface RequestUse {
  /** Relative to src/, forward slashes. */
  file: string;
  line: number;
  /** Source text of what `.request` was taken from. */
  receiver: string;
  /** Does the receiver's own name say it is a queue? */
  namesAQueue: boolean;
  /** Name of the enclosing function declaration, if any. */
  within: string | undefined;
  shape: "call" | "reference" | "destructure";
}

/** Peel wrappers that do not change what the receiver is. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isAwaitExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/** Does this expression, by its own name, denote a queue? */
function namesAQueue(e: ts.Expression): boolean {
  const cur = unwrap(e);
  if (ts.isIdentifier(cur)) return /queue/i.test(cur.text);
  if (ts.isPropertyAccessExpression(cur)) return /queue/i.test(cur.name.text);
  if (
    ts.isElementAccessExpression(cur) &&
    ts.isStringLiteralLike(cur.argumentExpression)
  ) {
    return /queue/i.test(cur.argumentExpression.text);
  }
  // getApprovalQueue(), this.getQueue(), …
  if (ts.isCallExpression(cur)) return namesAQueue(cur.expression);
  return false;
}

function enclosingFunction(node: ts.Node): string | undefined {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
  }
  return undefined;
}

/**
 * Every way production code can take `request` off an object: a call, a bare
 * reference (`x.request`, `x["request"]` — bound, passed or stored), or a
 * destructure (`const { request } = x`). Comments, strings and type positions
 * are not expressions and are never reported.
 */
function requestUses(file: string, text: string): RequestUse[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const uses: RequestUse[] = [];
  const push = (
    at: ts.Node,
    receiver: ts.Expression | undefined,
    shape: RequestUse["shape"],
  ) => {
    uses.push({
      file,
      line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1,
      receiver: receiver
        ? receiver.getText(sf).replace(/\s+/g, " ")
        : "<unknown>",
      namesAQueue: receiver ? namesAQueue(receiver) : false,
      within: enclosingFunction(at),
      shape,
    });
  };
  const visit = (node: ts.Node) => {
    const takesRequest =
      (ts.isPropertyAccessExpression(node) && node.name.text === "request") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "request");
    if (takesRequest) {
      const access = node as
        | ts.PropertyAccessExpression
        | ts.ElementAccessExpression;
      const called =
        ts.isCallExpression(node.parent) && node.parent.expression === node;
      push(node, access.expression, called ? "call" : "reference");
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && key.text === "request") {
        const decl = node.parent.parent;
        const from =
          ts.isVariableDeclaration(decl) && decl.initializer
            ? decl.initializer
            : undefined;
        push(node, from, "destructure");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

/**
 * The uses in one file that break the rule. `holdsQueue` is net B's switch:
 * in a file that can hold a queue every use counts; elsewhere only a use on
 * a receiver that names one (net A).
 */
function violations(
  file: string,
  text: string,
  exemptions: ReadonlyArray<{ file: string; receiver: string }> = NOT_A_QUEUE,
): RequestUse[] {
  const holdsQueue = QUEUE_HOLDER.test(text);
  return requestUses(file, text).filter((u) => {
    if (!holdsQueue && !u.namesAQueue) return false;
    const isTheOne =
      u.file === ALLOWED.file && u.within === ALLOWED.fn && u.shape === "call";
    if (isTheOne) return false;
    return !exemptions.some(
      (x) => x.file === u.file && x.receiver === u.receiver,
    );
  });
}

/** Every production source file under src/: no tests, no test directories. */
function productionFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...productionFiles(full));
    } else if (
      /\.(ts|mts|cts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|mts|cts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const rel = (full: string) => relative(SRC, full).split(sep).join("/");

const files = productionFiles().map((full) => ({
  file: rel(full),
  text: readFileSync(full, "utf-8"),
}));

describe("guard — production reaches the approval queue's request() in one place", () => {
  it("scanned the production tree (a scan of nothing must not pass)", () => {
    // A moved directory or a broken walk would otherwise report zero
    // violations — the same result as a clean tree.
    expect(files.length).toBeGreaterThan(200);
    const holders = files
      .filter((f) => QUEUE_HOLDER.test(f.text))
      .map((f) => f.file);
    // The four gates and the route: if these are not being looked at, the
    // guard is looking at the wrong tree.
    for (const known of [
      "approvalHttp.ts",
      "bridge.ts",
      "recipeOrchestration.ts",
      "server.ts",
      "streamableHttp.ts",
    ]) {
      expect(holders, known).toContain(known);
    }
  });

  it("no production code takes request() off an approval queue directly", () => {
    const found = files.flatMap((f) => violations(f.file, f.text));
    // If this fails you have added a path that queues an approval and tells
    // nobody. Call `enqueueApprovalWithDispatch` instead, with the channel
    // settings (`approvalNotifyChannels(server)`), and add a test that the
    // path announces — see workerGateApprovalNotifies.test.ts.
    //
    // If the `.request` is genuinely some other object's (an HTTP client, an
    // LSP client) in a file that also touches the queue, list it in
    // NOT_A_QUEUE above with the reason.
    expect(
      found.map(
        (u) => `${u.file}:${u.line} ${u.shape} of request on \`${u.receiver}\``,
      ),
    ).toEqual([]);
  });

  it("the one permitted use is a single call inside the dispatching helper", () => {
    const helperFile = files.find((f) => f.file === ALLOWED.file);
    expect(helperFile, ALLOWED.file).toBeDefined();
    const uses = requestUses(ALLOWED.file, helperFile?.text ?? "");
    // Exactly one, in exactly that function, on the queue it was handed. A
    // second call elsewhere in this file would be caught above; this pins
    // that the exemption itself has not quietly become "anything in
    // approvalHttp.ts".
    expect(
      uses.map((u) => ({
        within: u.within,
        receiver: u.receiver,
        shape: u.shape,
      })),
    ).toEqual([{ within: ALLOWED.fn, receiver: "deps.queue", shape: "call" }]);
  });

  it("every NOT_A_QUEUE exemption still matches a real use", () => {
    const stale = NOT_A_QUEUE.filter(
      (x) =>
        !files.some(
          (f) =>
            f.file === x.file &&
            requestUses(f.file, f.text).some((u) => u.receiver === x.receiver),
        ),
    );
    expect(stale).toEqual([]);
  });
});

describe("guard — the detector itself can fail", () => {
  // A guard that has only ever seen a clean tree is not known to be able to
  // say no. Each case is a shape a new silent caller could take.
  const holder = 'import { getApprovalQueue } from "./approvalQueue.js";\n';
  const flagged = (text: string, file = "newGate.ts") =>
    violations(file, text, []).map((u) => `${u.shape}:${u.receiver}`);

  it.each([
    ["the plain call", "const queue = getApprovalQueue();\nqueue.request({});"],
    ["straight off the getter", "getApprovalQueue().request({});"],
    [
      "a chained call split across lines",
      "getApprovalQueue()\n  .request({});",
    ],
    [
      "a name that does not say queue (net B)",
      "const q = getApprovalQueue();\nq.request({});",
    ],
    [
      "bracket access",
      'const queue = getApprovalQueue();\nqueue["request"]({});',
    ],
    [
      "a destructured method",
      "const { request } = getApprovalQueue();\nrequest({});",
    ],
    [
      "the method passed as a value",
      "const queue = getApprovalQueue();\nconst ask = queue.request.bind(queue);",
    ],
    [
      "inside a template literal",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this IS source text containing a template literal
      "const s = `${getApprovalQueue().request({})}`;",
    ],
  ])("flags %s", (_label, body) => {
    expect(flagged(holder + body)).not.toEqual([]);
  });

  it("flags a queue-named receiver in a file that names no queue type (net A)", () => {
    // No import, no type name: only the receiver's name gives it away.
    expect(
      flagged("export function f(deps: any) {\n  deps.queue.request({});\n}"),
    ).toEqual(["call:deps.queue"]);
    expect(
      flagged("export function f(s: any) {\n  s.approvalQueue.request({});\n}"),
    ).toEqual(["call:s.approvalQueue"]);
  });

  it("does not flag a comment or a string that only mentions it", () => {
    expect(
      flagged(
        `${holder}// called \`queue.request()\` directly\n/* queue.request( */\nconst s = "queue.request(";`,
      ),
    ).toEqual([]);
  });

  it("does not flag a type-level reference or a method declaration", () => {
    expect(
      flagged(
        `${holder}type A = Parameters<ApprovalQueue["request"]>;\nclass C { request() { return 1; } }`,
      ),
    ).toEqual([]);
  });

  it("does not flag another object's request() in a file that holds no queue", () => {
    expect(
      flagged(
        'import http from "node:http";\nhttp.request({});\nclient.request("x");\nthis.request();',
      ),
    ).toEqual([]);
  });

  it("the permitted call stops being permitted outside the helper or the file", () => {
    const call =
      "export function enqueueApprovalWithDispatch(deps: any) {\n  return deps.queue.request({});\n}";
    // In the helper, in its file: allowed.
    expect(flagged(call, ALLOWED.file)).toEqual([]);
    // Same code, another file: not.
    expect(flagged(call, "elsewhere.ts")).toEqual(["call:deps.queue"]);
    // Same file, another function: not.
    expect(
      flagged(
        "export function somethingElse(deps: any) {\n  return deps.queue.request({});\n}",
        ALLOWED.file,
      ),
    ).toEqual(["call:deps.queue"]);
  });
});
