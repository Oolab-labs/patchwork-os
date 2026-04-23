import { type FixtureEntry, recordFixture } from "./fixtureLibrary.js";

export async function captureFixture<TOutput>(
  filePath: string,
  provider: string,
  operation: string,
  input: unknown,
  fn: () => Promise<TOutput>,
): Promise<TOutput> {
  try {
    const output = await fn();
    recordFixture(filePath, provider, {
      operation,
      input,
      output,
    });
    return output;
  } catch (error) {
    recordFixture(filePath, provider, toErrorFixture(operation, input, error));
    throw error;
  }
}

function toErrorFixture(
  operation: string,
  input: unknown,
  error: unknown,
): FixtureEntry {
  if (error instanceof Error) {
    return {
      operation,
      input,
      error: {
        message: error.message,
      },
    };
  }

  return {
    operation,
    input,
    error: {
      message: String(error),
    },
  };
}
