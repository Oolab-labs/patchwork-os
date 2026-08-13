/**
 * Tests for the action-domain resolver seam.
 *
 * Why the seam exists: `DOMAIN_BY_TOOL` is a static allowlist keyed on exact
 * tool names, so any tool the bridge does not ship — a plugin tool, most
 * obviously — falls to `other` → `irreversible`. That is conservative, but it
 * collapses an entire integration into ONE trust cell: a read and a destructive
 * write become indistinguishable to the gate, which is precisely the
 * trust-transfer the action-class design exists to prevent.
 *
 * Why it is OPERATOR-asserted and not plugin-declared: reversible actions
 * bypass the gate unconditionally. A tool that could declare its own
 * reversibility could therefore declare itself out of governance entirely.
 * Classification must never be controlled by the thing being classified.
 *
 * The safety property under test is narrow and load-bearing: the resolver may
 * only classify tools the bridge does NOT already know. It can never re-map,
 * soften, or shadow a built-in mapping.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  classifyActionClass,
  registerActionDomainResolver,
} from "../actionClass.js";

afterEach(() => {
  registerActionDomainResolver(null);
});

describe("action-domain resolver seam", () => {
  it("leaves unknown tools at other:irreversible when no resolver is set", () => {
    const ac = classifyActionClass("acmeCrm_list_records");
    expect(ac.domain).toBe("other");
    expect(ac.reversibility).toBe("irreversible");
  });

  it("lets an operator classify an unknown tool as a reversible read", () => {
    registerActionDomainResolver((tool) =>
      tool === "acmeCrm_list_records" ? { domain: "fs-read" } : undefined,
    );
    const ac = classifyActionClass("acmeCrm_list_records");
    expect(ac.domain).toBe("fs-read");
    expect(ac.reversibility).toBe("reversible");
  });

  it("keeps distinct classes for distinct tools instead of one shared cell", () => {
    registerActionDomainResolver((tool) =>
      tool.endsWith("_list_records") ? { domain: "fs-read" } : undefined,
    );
    const read = classifyActionClass("acmeCrm_list_records");
    const other = classifyActionClass("acmeBooks_create_invoice");
    expect(read.key).not.toBe(other.key);
    expect(other.reversibility).toBe("irreversible");
  });

  // The security property. A resolver that could re-map a built-in tool could
  // declare `gitPush` reversible and walk it straight past the gate.
  it("cannot override a built-in mapping", () => {
    registerActionDomainResolver(() => ({
      domain: "fs-read",
      reversibility: "reversible",
    }));
    const ac = classifyActionClass("gitPush");
    expect(ac.domain).toBe("vcs-push");
    expect(ac.reversibility).toBe("compensable");
  });

  it("cannot soften the agent step carve-out", () => {
    registerActionDomainResolver(() => ({
      domain: "fs-read",
      reversibility: "reversible",
    }));
    const ac = classifyActionClass("agent");
    expect(ac.reversibility).not.toBe("reversible");
  });

  it("falls back to irreversible for a domain it does not recognise", () => {
    registerActionDomainResolver(() => ({ domain: "not-a-real-domain" }));
    const ac = classifyActionClass("acmeBooks_create_invoice");
    expect(ac.reversibility).toBe("irreversible");
  });

  // A resolver is operator-supplied config; a throw must degrade to the
  // conservative default rather than take the gate down with it. A crashing
  // gate is an outage, and an outage is the pressure that gets gates disabled.
  it("fails closed when the resolver throws", () => {
    registerActionDomainResolver(() => {
      throw new Error("bad config");
    });
    const ac = classifyActionClass("acmeBooks_create_invoice");
    expect(ac.domain).toBe("other");
    expect(ac.reversibility).toBe("irreversible");
  });

  it("still applies magnitude banding when mapped to a banded domain", () => {
    registerActionDomainResolver(() => ({ domain: "payments" }));
    const small = classifyActionClass("acmeBooks_create_payment", {
      amount: 5,
    });
    const large = classifyActionClass("acmeBooks_create_payment", {
      amount: 50_000,
    });
    expect(small.key).not.toBe(large.key);
  });

  it("unregisters cleanly", () => {
    registerActionDomainResolver(() => ({ domain: "fs-read" }));
    expect(classifyActionClass("acmeCrm_list_records").domain).toBe("fs-read");
    registerActionDomainResolver(null);
    expect(classifyActionClass("acmeCrm_list_records").domain).toBe("other");
  });
});
