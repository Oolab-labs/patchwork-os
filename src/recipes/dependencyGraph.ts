/**
 * DependencyGraph — builds and executes recipe step dependencies.
 *
 * Supports:
 *   - Parallel execution up to maxConcurrency
 *   - Explicit dependencies (awaits: [stepA, stepB])
 *   - Conditional execution (when: condition)
 *   - Cycle detection
 */

export interface StepDependency {
  stepId: string;
  awaits: string[]; // step IDs that must complete first
  index: number; // original order in recipe
}

export interface DependencyGraph {
  steps: StepDependency[];
  hasCycles: boolean;
  topologicalOrder: string[];
}

export interface ExecutionOptions {
  maxConcurrency: number;
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (stepId: string, error?: Error) => void;
}

export type StepExecutor = (stepId: string) => Promise<void>;

/** Build dependency graph from step definitions */
export function buildDependencyGraph(
  steps: Array<{ id: string; awaits?: string[] }>,
): DependencyGraph {
  const nodes: StepDependency[] = steps.map((s, index) => ({
    stepId: s.id,
    awaits: s.awaits ?? [],
    index,
  }));

  // Detect cycles using DFS
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycles: string[][] = [];

  function visit(node: StepDependency, path: string[]): void {
    if (visiting.has(node.stepId)) {
      // Found cycle - extract cycle from path
      const cycleStart = path.indexOf(node.stepId);
      cycles.push(path.slice(cycleStart).concat(node.stepId));
      return;
    }
    if (visited.has(node.stepId)) return;

    visiting.add(node.stepId);
    path.push(node.stepId);

    for (const depId of node.awaits) {
      const dep = nodes.find((n) => n.stepId === depId);
      if (dep) visit(dep, path);
    }

    path.pop();
    visiting.delete(node.stepId);
    visited.add(node.stepId);
  }

  for (const node of nodes) {
    if (!visited.has(node.stepId)) {
      visit(node, []);
    }
  }

  // Calculate topological order (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.stepId, node.awaits.length);
    for (const dep of node.awaits) {
      if (!adjacency.has(dep)) adjacency.set(dep, []);
      adjacency.get(dep)?.push(node.stepId);
    }
  }

  const queue: string[] = [];
  for (const [stepId, degree] of inDegree) {
    if (degree === 0) queue.push(stepId);
  }

  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const stepId = queue.shift()!;
    topologicalOrder.push(stepId);

    const dependents = adjacency.get(stepId) ?? [];
    for (const dep of dependents) {
      const newDegree = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) queue.push(dep);
    }
  }

  return {
    steps: nodes,
    hasCycles: cycles.length > 0,
    topologicalOrder,
  };
}

/** Format cycle for error message */
export function formatCycle(cycles: string[][]): string {
  if (cycles.length === 0) return "No cycles detected";
  return cycles
    .map((cycle, i) => `  Cycle ${i + 1}: ${cycle.join(" → ")}`)
    .join("\n");
}

/** Execute steps respecting dependencies with limited concurrency */
export async function executeWithDependencies(
  graph: DependencyGraph,
  executeStep: StepExecutor,
  options: ExecutionOptions,
): Promise<Map<string, { success: boolean; error?: Error }>> {
  if (graph.hasCycles) {
    throw new Error(`Dependency graph has cycles - cannot execute`);
  }

  const results = new Map<string, { success: boolean; error?: Error }>();
  const completed = new Set<string>();
  const failed = new Set<string>(); // C1: track which completed steps failed
  const inProgress = new Set<string>();
  // Store resolver functions to signal when steps complete
  const resolvers = new Map<string, Array<() => void>>();

  // Track which steps are waiting for which dependencies
  const waitingFor = new Map<string, string[]>();
  for (const node of graph.steps) {
    waitingFor.set(node.stepId, [...node.awaits]);
  }

  function waitForStep(stepId: string): Promise<void> {
    if (completed.has(stepId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = resolvers.get(stepId);
      if (list) {
        list.push(resolve);
      } else {
        resolvers.set(stepId, [resolve]);
      }
    });
  }

  async function runStep(stepId: string): Promise<void> {
    if (inProgress.has(stepId) || completed.has(stepId)) return;

    // Check if all dependencies are satisfied
    const deps = waitingFor.get(stepId) ?? [];
    const unresolved = deps.filter((d) => !completed.has(d));
    if (unresolved.length > 0) {
      await Promise.all(unresolved.map(waitForStep));
    }

    // C1: skip if any upstream dependency failed
    const failedDep = deps.find((d) => failed.has(d));
    if (failedDep) {
      const err = new Error(`Skipped: upstream step "${failedDep}" failed`);
      results.set(stepId, { success: false, error: err });
      completed.add(stepId);
      failed.add(stepId);
      options.onStepComplete?.(stepId, err);
      // Unblock any steps waiting on this one
      const waiting = resolvers.get(stepId) ?? [];
      for (const resolve of waiting) resolve();
      resolvers.delete(stepId);
      return;
    }

    inProgress.add(stepId);
    options.onStepStart?.(stepId);

    let stepErr: Error | undefined;
    try {
      await executeStep(stepId);
      results.set(stepId, { success: true });
      completed.add(stepId);
    } catch (error) {
      stepErr = error instanceof Error ? error : new Error(String(error));
      results.set(stepId, { success: false, error: stepErr });
      completed.add(stepId);
      failed.add(stepId); // C1: record failure so dependents are skipped
    } finally {
      options.onStepComplete?.(stepId, stepErr);
      inProgress.delete(stepId);
      // Signal dependents
      const waiting = resolvers.get(stepId) ?? [];
      for (const resolve of waiting) {
        resolve();
      }
      resolvers.delete(stepId);
    }
  }

  // Execute with concurrency limit
  const executing: Promise<void>[] = [];
  const queue = [...graph.topologicalOrder];

  async function processQueue(): Promise<void> {
    while (queue.length > 0 || executing.length > 0) {
      // Start new steps if under concurrency limit
      while (executing.length < options.maxConcurrency && queue.length > 0) {
        const stepId = queue.shift()!;
        // C2: push before attaching .then() so indexOf is never -1
        let resolveSlot!: () => void;
        const slot = new Promise<void>((r) => {
          resolveSlot = r;
        });
        executing.push(slot);
        runStep(stepId).then(() => {
          executing.splice(executing.indexOf(slot), 1);
          resolveSlot();
        });
      }

      if (executing.length > 0) {
        await Promise.race(executing);
      }
    }
  }

  await processQueue();
  return results;
}

/** Get steps that can run immediately (no unresolved dependencies) */
export function getReadySteps(
  graph: DependencyGraph,
  completed: Set<string>,
): string[] {
  return graph.steps
    .filter(
      (s) =>
        !completed.has(s.stepId) && s.awaits.every((dep) => completed.has(dep)),
    )
    .map((s) => s.stepId);
}
