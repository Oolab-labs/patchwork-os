// Deliberately broken to trigger onDiagnosticsError.
// The TypeScript language server will report:
//   - TS2322: Type 'string' is not assignable to type 'number'
//   - TS2345: Argument of type 'number' is not assignable to parameter of type 'string'
//
// Save this file (or open it with the bridge running) and the automation hook
// will dispatch a Claude subprocess to diagnose + propose the fix.

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// Bug 1: total should be a number, but the initializer is a string.
const total: number = "ten";

// Bug 2: greet() expects a string, but we're passing total (which we
// declared as a number — see bug 1). This is a second, independent
// error Claude should spot.
const message = greet(total);

console.log(message, total);
