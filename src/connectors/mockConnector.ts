import {
  type AuthContext,
  BaseConnector,
  type ConnectorError,
  type ConnectorStatus,
  type OAuthConfig,
} from "./baseConnector.js";
import {
  createFixtureLibrary,
  type FixtureEntry,
  type FixtureLibrary,
  findFixture,
  loadFixtureLibrary,
  recordFixture,
} from "./fixtureLibrary.js";

export interface MockCall {
  operation: string;
  input?: unknown;
  matched: boolean;
}

export class MockConnector extends BaseConnector {
  readonly providerName: string;
  private readonly fixturePath?: string;
  private readonly library: FixtureLibrary;
  private readonly calls: MockCall[] = [];

  constructor(providerName: string, options: { fixturePath?: string } = {}) {
    super();
    this.providerName = providerName;
    this.fixturePath = options.fixturePath;
    this.library = options.fixturePath
      ? (loadFixtureLibrary(options.fixturePath) ??
        createFixtureLibrary(providerName))
      : createFixtureLibrary(providerName);
  }

  protected getOAuthConfig(): OAuthConfig | null {
    return null;
  }

  async authenticate(): Promise<AuthContext> {
    return {
      token: `mock-${this.providerName}`,
      scopes: ["mock"],
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }> {
    return { ok: true };
  }

  normalizeError(error: unknown): ConnectorError {
    if (error && typeof error === "object" && "message" in error) {
      const err = error as {
        message: string;
        code?: string;
        retryable?: boolean;
      };
      return {
        code:
          (err.code as ConnectorError["code"] | undefined) ?? "provider_error",
        message: err.message,
        retryable: err.retryable ?? false,
      };
    }
    return {
      code: "provider_error",
      message: String(error),
      retryable: false,
    };
  }

  getStatus(): ConnectorStatus {
    return {
      id: this.providerName,
      status: "connected",
    };
  }

  async invoke<TOutput = unknown>(
    operation: string,
    input?: unknown,
  ): Promise<TOutput> {
    const fixture = findFixture(this.library, operation, input);
    this.calls.push({ operation, input, matched: fixture !== null });

    if (!fixture) {
      throw new Error(
        `No mock fixture for ${this.providerName}.${operation} with input ${JSON.stringify(input ?? null)}`,
      );
    }

    if (fixture.error) {
      throw Object.assign(new Error(fixture.error.message), {
        code: fixture.error.code,
        retryable: fixture.error.retryable,
      });
    }

    return fixture.output as TOutput;
  }

  addFixture(entry: FixtureEntry): void {
    this.library.fixtures.push(entry);
    if (this.fixturePath) {
      recordFixture(this.fixturePath, this.providerName, entry);
    }
  }

  getCalls(): MockCall[] {
    return [...this.calls];
  }

  getLibrary(): FixtureLibrary {
    return {
      version: this.library.version,
      provider: this.library.provider,
      fixtures: [...this.library.fixtures],
    };
  }
}
