import { describe, expect, it } from "vitest";
import { CircuitBreaker, deriveBreakerKey } from "../circuitBreaker.js";

describe("deriveBreakerKey", () => {
  it("is stable for the same (recipeName, toolId) pair", () => {
    expect(deriveBreakerKey("my-recipe", "file.write")).toBe(
      deriveBreakerKey("my-recipe", "file.write"),
    );
  });

  it("differs across recipes for the same tool", () => {
    expect(deriveBreakerKey("recipe-a", "file.write")).not.toBe(
      deriveBreakerKey("recipe-b", "file.write"),
    );
  });

  it("differs across tools for the same recipe", () => {
    expect(deriveBreakerKey("my-recipe", "file.write")).not.toBe(
      deriveBreakerKey("my-recipe", "file.read"),
    );
  });
});

describe("CircuitBreaker", () => {
  it("stays closed below the failure threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(false);
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 2,
      open: false,
    });
  });

  it("opens after `failureThreshold` consecutive failures", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(true);
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 3,
      open: true,
    });
  });

  it("a success resets the failure streak and closes the breaker", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    breaker.recordSuccess("k");
    expect(breaker.isOpen("k")).toBe(false);
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 0,
      open: false,
    });
  });

  it("does not open a DIFFERENT key when one key trips", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });

  it("moves to half-open (isOpen returns false) once the cooldown elapses", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100);
    expect(breaker.isOpen("k", 200)).toBe(true);
    // Cooldown (1000ms from the trip at t=100) hasn't elapsed yet.
    expect(breaker.isOpen("k", 1099)).toBe(true);
    // Cooldown elapsed — half-open probe let through.
    expect(breaker.isOpen("k", 1100)).toBe(false);
  });

  it("re-opens immediately if the half-open probe itself fails", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100);
    expect(breaker.isOpen("k", 1100)).toBe(false); // half-open probe allowed
    breaker.recordFailure("k", 1100); // probe fails
    expect(breaker.isOpen("k", 1100)).toBe(true);
  });

  it("a successful half-open probe fully closes the breaker", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100);
    expect(breaker.isOpen("k", 1100)).toBe(false); // half-open probe allowed
    breaker.recordSuccess("k");
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 0,
      open: false,
    });
  });

  it("uses default threshold (5) and cooldown (10m) when unset", () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 4; i++) breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(false);
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(true);
  });
});
