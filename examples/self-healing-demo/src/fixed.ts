// Reference: what src/broken.ts looks like after the bugs are fixed.
// Diff against broken.ts to see the minimal patch Claude should propose.

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

const total: number = 10;

const message = greet(String(total));

console.log(message, total);
