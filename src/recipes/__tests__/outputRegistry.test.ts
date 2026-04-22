import { describe, expect, it } from "vitest";
import { createOutputRegistry } from "../outputRegistry.js";

describe("OutputRegistry", () => {
  it("stores and retrieves step output", () => {
    const r = createOutputRegistry();
    r.set("step1", { status: "success", data: { result: "ok" } });
    expect(r.get("step1")).toEqual({
      status: "success",
      data: { result: "ok" },
    });
  });

  it("returns undefined for unknown step", () => {
    const r = createOutputRegistry();
    expect(r.get("missing")).toBeUndefined();
  });

  it("has() returns correct values", () => {
    const r = createOutputRegistry();
    expect(r.has("x")).toBe(false);
    r.set("x", { status: "success" });
    expect(r.has("x")).toBe(true);
  });

  it("keys() lists all stored steps", () => {
    const r = createOutputRegistry();
    r.set("a", { status: "success" });
    r.set("b", { status: "error" });
    expect(r.keys().sort()).toEqual(["a", "b"]);
  });

  it("toTemplateContext exposes steps and env", () => {
    const r = createOutputRegistry();
    r.set("fetch", { status: "success", data: { url: "https://example.com" } });
    const ctx = r.toTemplateContext({ HOME: "/home/user" });
    expect(ctx.steps.fetch?.data).toEqual({ url: "https://example.com" });
    expect(ctx.env.HOME).toBe("/home/user");
  });

  it("summary counts correctly", () => {
    const r = createOutputRegistry();
    r.set("a", { status: "success" });
    r.set("b", { status: "success" });
    r.set("c", { status: "error" });
    r.set("d", { status: "skipped" });
    expect(r.summary()).toEqual({
      total: 4,
      succeeded: 2,
      failed: 1,
      skipped: 1,
    });
  });

  it("summary is all zeros for empty registry", () => {
    const r = createOutputRegistry();
    expect(r.summary()).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it("overwrites existing entry on set", () => {
    const r = createOutputRegistry();
    r.set("step1", { status: "success", data: "first" });
    r.set("step1", { status: "error", data: "second" });
    expect(r.get("step1")).toEqual({ status: "error", data: "second" });
    expect(r.summary().total).toBe(1);
  });
});
