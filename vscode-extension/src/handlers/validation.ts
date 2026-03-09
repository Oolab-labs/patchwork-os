/** Shared parameter validation helpers for extension handlers */

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return value;
}

export function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} is required and must be a finite number`);
  }
  return value;
}
