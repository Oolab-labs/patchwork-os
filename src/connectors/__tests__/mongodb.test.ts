import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We import the SUT lazily in each test (after vi.resetModules) so module
// state (singleton client, injected driver, secret cache) is hermetic.

type FakeOps = {
  ping?: () => Promise<unknown>;
  listDatabases?: () => Promise<{ databases: Array<{ name: string }> }>;
  listCollections?: () => Array<{ name: string }>;
  findOne?: () => Promise<unknown>;
  indexes?: () => Promise<unknown[]>;
  find?: () => Promise<unknown[]>;
  aggregate?: () => Promise<unknown[]>;
  estimatedDocumentCount?: () => Promise<number>;
  countDocuments?: () => Promise<number>;
};

function makeFakeMongo(ops: FakeOps = {}) {
  const calls: { connect: number; close: number } = { connect: 0, close: 0 };

  class FakeClient {
    public uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async connect() {
      calls.connect++;
      return this;
    }
    async close() {
      calls.close++;
      return undefined;
    }
    db(_name?: string) {
      return {
        admin() {
          return {
            async listDatabases() {
              return (
                ops.listDatabases?.() ?? {
                  databases: [{ name: "admin" }, { name: "test" }],
                }
              );
            },
            async command(cmd: Record<string, unknown>) {
              if (cmd.ping !== undefined) {
                return ops.ping ? ops.ping() : { ok: 1 };
              }
              return { ok: 1 };
            },
          };
        },
        async command(cmd: Record<string, unknown>) {
          if (cmd.ping !== undefined) {
            return ops.ping ? ops.ping() : { ok: 1 };
          }
          return { ok: 1 };
        },
        listCollections() {
          return {
            async toArray() {
              return (
                ops.listCollections?.() ?? [
                  { name: "users" },
                  { name: "orders" },
                ]
              );
            },
          };
        },
        collection(_n: string) {
          return {
            async indexes() {
              return ops.indexes?.() ?? [{ name: "_id_" }];
            },
            async findOne() {
              return ops.findOne?.() ?? { _id: "x" };
            },
            find() {
              return {
                async toArray() {
                  return ops.find?.() ?? [{ _id: "a" }];
                },
              };
            },
            aggregate() {
              return {
                async toArray() {
                  return ops.aggregate?.() ?? [{ _id: "agg" }];
                },
              };
            },
            async estimatedDocumentCount() {
              return ops.estimatedDocumentCount?.() ?? 42;
            },
            async countDocuments() {
              return ops.countDocuments?.() ?? 7;
            },
          };
        },
      };
    }
  }

  return {
    calls,
    module: {
      MongoClient: FakeClient as unknown as new (
        uri: string,
      ) => InstanceType<typeof FakeClient>,
    },
  };
}

describe("mongodb connector", () => {
  const tmpDir = join(os.tmpdir(), `patchwork-mongo-${Date.now()}`);
  const homeDir = join(tmpDir, "home");
  const patchworkHome = join(homeDir, ".patchwork");
  const tokensDir = join(patchworkHome, "tokens");

  beforeEach(() => {
    process.env.HOME = homeDir;
    process.env.PATCHWORK_HOME = patchworkHome;
    process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
    mkdirSync(tokensDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.PATCHWORK_HOME;
    delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DATABASE;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("isReadOnlyMongoOp", () => {
    it("accepts plain filters", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      expect(isReadOnlyMongoOp({ status: "open", count: { $gt: 5 } })).toBe(
        true,
      );
      expect(isReadOnlyMongoOp([{ $match: { a: 1 } }, { $limit: 10 }])).toBe(
        true,
      );
      expect(isReadOnlyMongoOp(null)).toBe(true);
      expect(isReadOnlyMongoOp(undefined)).toBe(true);
    });

    it("rejects $where at top level", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      expect(() => isReadOnlyMongoOp({ $where: "this.x === 1" })).toThrow(
        /\$where/,
      );
    });

    it("rejects $function at top level", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      expect(() => isReadOnlyMongoOp({ $function: {} })).toThrow(/\$function/);
    });

    it("rejects $accumulator at any depth", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      expect(() =>
        isReadOnlyMongoOp({ outer: { inner: { $accumulator: {} } } }),
      ).toThrow(/\$accumulator/);
    });

    it("rejects $out and $merge nested in arrays", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      expect(() =>
        isReadOnlyMongoOp([{ $match: {} }, { $out: "evil" }]),
      ).toThrow(/\$out/);
      expect(() => isReadOnlyMongoOp([{ $merge: { into: "evil" } }])).toThrow(
        /\$merge/,
      );
    });

    it("is case-insensitive", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      expect(() => isReadOnlyMongoOp({ $WHERE: "x" })).toThrow();
      expect(() => isReadOnlyMongoOp({ $Out: "x" })).toThrow();
    });

    it("rejects when buried deep in nested object", async () => {
      const { isReadOnlyMongoOp } = await import("../mongodb.js");
      const buried = {
        a: { b: { c: { d: { e: { $where: "hack" } } } } },
      };
      expect(() => isReadOnlyMongoOp(buried)).toThrow(/\$where/);
    });
  });

  describe("normalizeError", () => {
    it("maps mongo code 18 to auth_expired", async () => {
      const { mongoConnector } = await import("../mongodb.js");
      const err = Object.assign(new Error("auth failed"), { code: 18 });
      const out = mongoConnector().normalizeError(err);
      expect(out.code).toBe("auth_expired");
      expect(out.retryable).toBe(false);
    });

    it("maps code 13 to permission_denied", async () => {
      const { mongoConnector } = await import("../mongodb.js");
      const err = Object.assign(new Error("unauthorized"), { code: 13 });
      expect(mongoConnector().normalizeError(err).code).toBe(
        "permission_denied",
      );
    });

    it("maps code 11 (UserNotFound) to not_found", async () => {
      const { mongoConnector } = await import("../mongodb.js");
      const err = Object.assign(new Error("no user"), { code: 11 });
      expect(mongoConnector().normalizeError(err).code).toBe("not_found");
    });

    it("maps code 26 (NamespaceNotFound) to not_found", async () => {
      const { mongoConnector } = await import("../mongodb.js");
      const err = Object.assign(new Error("ns missing"), { code: 26 });
      expect(mongoConnector().normalizeError(err).code).toBe("not_found");
    });

    it("maps MongoNetworkError name to retryable network_error", async () => {
      const { mongoConnector } = await import("../mongodb.js");
      const err = Object.assign(new Error("conn reset"), {
        name: "MongoNetworkError",
      });
      const out = mongoConnector().normalizeError(err);
      expect(out.code).toBe("network_error");
      expect(out.retryable).toBe(true);
    });

    it("falls back to provider_error for unknown codes", async () => {
      const { mongoConnector } = await import("../mongodb.js");
      const err = Object.assign(new Error("weird"), { code: 9999 });
      expect(mongoConnector().normalizeError(err).code).toBe("provider_error");
    });
  });

  describe("handleMongoConnect", () => {
    it("rejects malformed connection strings", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);
      const res = await mod.handleMongoConnect({
        connectionString: "http://nope",
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).ok).toBe(false);
      mod.__setMongoModuleForTest(null);
    });

    it("rejects empty connection string", async () => {
      const mod = await import("../mongodb.js");
      const res = await mod.handleMongoConnect({ connectionString: "" });
      expect(res.status).toBe(400);
    });

    it("pings on connect and persists tokens", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);

      const res = await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
        database: "app",
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
      expect(fake.calls.connect).toBeGreaterThanOrEqual(1);

      const reloaded = mod.loadTokens();
      expect(reloaded?.connectionString).toBe("mongodb://localhost:27017");
      expect(reloaded?.database).toBe("app");

      mod.__setMongoModuleForTest(null);
    });

    it("returns 400 when ping rejects", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo({
        ping: async () => {
          throw Object.assign(new Error("auth fail"), { code: 18 });
        },
      });
      mod.__setMongoModuleForTest(fake.module);

      const res = await mod.handleMongoConnect({
        connectionString: "mongodb://bad@localhost",
      });
      expect(res.status).toBe(400);
      expect(mod.loadTokens()).toBeNull();
      mod.__setMongoModuleForTest(null);
    });
  });

  describe("query surface", () => {
    it("listDatabases returns names", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);
      await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
      });

      const dbs = await mod.listDatabases();
      expect(dbs).toEqual(["admin", "test"]);
      mod.__setMongoModuleForTest(null);
    });

    it("find caps limit at 1000", async () => {
      const mod = await import("../mongodb.js");
      let capturedOptions: Record<string, unknown> | undefined;
      const fake = makeFakeMongo();
      // Wrap collection.find to capture options.
      const originalDb = fake.module.MongoClient.prototype as unknown as {
        db: (n?: string) => unknown;
      };
      void originalDb; // unused, but kept to make the patch site explicit
      // Easier: override module's MongoClient to intercept find().
      class IntercClient {
        async connect() {
          return this;
        }
        async close() {
          return undefined;
        }
        db(_n?: string) {
          return {
            admin: () => ({
              async command() {
                return { ok: 1 };
              },
              async listDatabases() {
                return { databases: [] };
              },
            }),
            async command() {
              return { ok: 1 };
            },
            listCollections() {
              return {
                async toArray() {
                  return [];
                },
              };
            },
            collection() {
              return {
                async indexes() {
                  return [];
                },
                async findOne() {
                  return null;
                },
                find(_f: unknown, opts: Record<string, unknown>) {
                  capturedOptions = opts;
                  return {
                    async toArray() {
                      return [];
                    },
                  };
                },
                aggregate() {
                  return {
                    async toArray() {
                      return [];
                    },
                  };
                },
                async estimatedDocumentCount() {
                  return 0;
                },
                async countDocuments() {
                  return 0;
                },
              };
            },
          };
        }
      }
      mod.__setMongoModuleForTest({
        MongoClient: IntercClient as unknown as new (
          uri: string,
        ) => InstanceType<typeof IntercClient>,
      });
      await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
      });

      await mod.find("app", "users", {}, { limit: 999999 });
      expect(capturedOptions?.limit).toBe(1000);

      await mod.find("app", "users", {}, { limit: -5 });
      expect(capturedOptions?.limit).toBe(100); // default

      mod.__setMongoModuleForTest(null);
    });

    it("find rejects filters with $where", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);
      await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
      });

      await expect(
        mod.find("app", "users", { $where: "true" }),
      ).rejects.toThrow(/\$where/);
      mod.__setMongoModuleForTest(null);
    });

    it("aggregate rejects $out stage", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);
      await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
      });

      await expect(
        mod.aggregate("app", "users", [{ $match: {} }, { $out: "x" }]),
      ).rejects.toThrow(/\$out/);
      mod.__setMongoModuleForTest(null);
    });

    it("count uses estimatedDocumentCount when no filter", async () => {
      const mod = await import("../mongodb.js");
      let usedEstimate = false;
      let usedCount = false;
      class C {
        async connect() {
          return this;
        }
        async close() {
          return undefined;
        }
        db() {
          return {
            admin: () => ({
              async command() {
                return { ok: 1 };
              },
              async listDatabases() {
                return { databases: [] };
              },
            }),
            async command() {
              return { ok: 1 };
            },
            listCollections() {
              return {
                async toArray() {
                  return [];
                },
              };
            },
            collection() {
              return {
                async indexes() {
                  return [];
                },
                async findOne() {
                  return null;
                },
                find() {
                  return {
                    async toArray() {
                      return [];
                    },
                  };
                },
                aggregate() {
                  return {
                    async toArray() {
                      return [];
                    },
                  };
                },
                async estimatedDocumentCount() {
                  usedEstimate = true;
                  return 999;
                },
                async countDocuments() {
                  usedCount = true;
                  return 5;
                },
              };
            },
          };
        }
      }
      mod.__setMongoModuleForTest({
        MongoClient: C as unknown as new (
          uri: string,
        ) => InstanceType<typeof C>,
      });
      await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
      });

      expect(await mod.count("app", "users")).toBe(999);
      expect(usedEstimate).toBe(true);
      expect(usedCount).toBe(false);

      expect(await mod.count("app", "users", { active: true })).toBe(5);
      expect(usedCount).toBe(true);

      mod.__setMongoModuleForTest(null);
    });
  });

  describe("disconnect", () => {
    it("clears tokens and closes the client", async () => {
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);
      await mod.handleMongoConnect({
        connectionString: "mongodb://localhost:27017",
      });
      expect(mod.loadTokens()).not.toBeNull();

      const res = await mod.handleMongoDisconnect();
      expect(res.status).toBe(200);
      expect(mod.loadTokens()).toBeNull();
      expect(fake.calls.close).toBeGreaterThanOrEqual(1);
      mod.__setMongoModuleForTest(null);
    });
  });

  // H1 — audit 2026-06-19: SSRF via private/internal MongoDB connection strings
  describe("handleMongoConnect — SSRF guard (H1)", () => {
    it("rejects a private IPv4 host (AWS metadata) with 400", async () => {
      const mod = await import("../mongodb.js");
      const res = await mod.handleMongoConnect({
        connectionString: "mongodb://169.254.169.254:27017",
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false });
    });

    it("rejects a private IPv4 host (10.x.x.x) with 400", async () => {
      const mod = await import("../mongodb.js");
      const res = await mod.handleMongoConnect({
        connectionString: "mongodb://10.0.0.1:27017",
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false });
    });
  });

  describe("getClient — double-connect race (M2)", () => {
    it("creates exactly one MongoClient when two listDatabases() calls race concurrently", async () => {
      // Fresh module state so _client is null
      vi.resetModules();
      const mod = await import("../mongodb.js");
      const fake = makeFakeMongo();
      mod.__setMongoModuleForTest(fake.module);
      // Seed tokens so listDatabases() can proceed without connect
      mod.saveTokens({
        connectionString: "mongodb://localhost:27017",
        connected_at: new Date().toISOString(),
      });

      // Race two concurrent listDatabases() calls — both internally call getClient()
      // which must not double-connect.
      const [r1, r2] = await Promise.all([
        mod.listDatabases(),
        mod.listDatabases(),
      ]);
      expect(r1).toEqual(r2);
      // connect() must have been called exactly once
      expect(fake.calls.connect).toBe(1);
    });
  });

  describe("lazy driver loader", () => {
    it("surfaces a friendly error when mongodb is not installed", async () => {
      // No injected module + a forced import failure path: easiest way is to
      // intercept the dynamic import via vi.mock for "mongodb".
      vi.doMock("mongodb", () => {
        throw new Error("Cannot find module 'mongodb'");
      });
      vi.resetModules();
      const mod = await import("../mongodb.js");
      mod.__setMongoModuleForTest(null);
      await expect(
        mod.handleMongoConnect({
          connectionString: "mongodb://localhost:27017",
        }),
      ).resolves.toMatchObject({ status: 400 });
      vi.doUnmock("mongodb");
    });
  });
});
