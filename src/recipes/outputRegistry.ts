/**
 * OutputRegistry — per-recipe-run state container for step outputs.
 *
 * Isolated from other runs, no persistence. Used by template engine
 * to resolve {{steps.X.data.field}} references.
 */

import type { StepOutput, TemplateContext } from "./templateEngine.js";

export interface OutputRegistry {
  /** Store output from a completed step */
  set(stepId: string, output: StepOutput): void;

  /** Get output for a step, or undefined if not yet run */
  get(stepId: string): StepOutput | undefined;

  /** Check if a step has completed */
  has(stepId: string): boolean;

  /** Get all step IDs that have outputs */
  keys(): string[];

  /** Convert to TemplateContext for template resolution */
  toTemplateContext(env: Record<string, string | undefined>): TemplateContext;

  /** Summary for logging/debugging */
  summary(): {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}

class OutputRegistryImpl implements OutputRegistry {
  private outputs = new Map<string, StepOutput>();

  set(stepId: string, output: StepOutput): void {
    this.outputs.set(stepId, output);
  }

  get(stepId: string): StepOutput | undefined {
    return this.outputs.get(stepId);
  }

  has(stepId: string): boolean {
    return this.outputs.has(stepId);
  }

  keys(): string[] {
    return Array.from(this.outputs.keys());
  }

  toTemplateContext(env: Record<string, string | undefined>): TemplateContext {
    const steps: Record<string, StepOutput> = {};
    for (const [key, value] of this.outputs) {
      steps[key] = value;
    }
    return { steps, env };
  }

  summary(): {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  } {
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const output of this.outputs.values()) {
      if (output.status === "success") succeeded++;
      else if (output.status === "error") failed++;
      else if (output.status === "skipped") skipped++;
    }
    return {
      total: this.outputs.size,
      succeeded,
      failed,
      skipped,
    };
  }
}

/** Create a new isolated OutputRegistry for a recipe run */
export function createOutputRegistry(): OutputRegistry {
  return new OutputRegistryImpl();
}
