/**
 * Grafana recipe-step tools — read set (list_dashboards, list_alert_rules,
 * query_datasource) plus a single write (create_annotation).
 *
 * Mocks the Grafana connector module so the self-registering tool module can be
 * imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful positional param mapping into the
 * connector calls and that the raw connector return type is JSON-stringified
 * back out. Verifies isWrite/risk metadata: reads are non-write/low,
 * create_annotation is write/medium.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getGrafanaConnector returns it.

const getDashboards = vi.fn();
const getAlertRules = vi.fn();
const createAnnotation = vi.fn();
const queryDataSource = vi.fn();

vi.mock("../../../connectors/grafana.js", () => ({
  getGrafanaConnector: () => ({
    getDashboards,
    getAlertRules,
    createAnnotation,
    queryDataSource,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../grafana.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("grafana recipe-step tools", () => {
  beforeEach(() => {
    getDashboards.mockReset();
    getAlertRules.mockReset();
    createAnnotation.mockReset();
    queryDataSource.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers all four tools with the grafana namespace + outputSchema", () => {
    for (const id of [
      "grafana.list_dashboards",
      "grafana.list_alert_rules",
      "grafana.create_annotation",
      "grafana.query_datasource",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("grafana");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("read tools are non-write / low risk", () => {
    for (const id of [
      "grafana.list_dashboards",
      "grafana.list_alert_rules",
      "grafana.query_datasource",
    ]) {
      const tool = getTool(id);
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
    }
  });

  it("create_annotation is write / medium risk", () => {
    const tool = getTool("grafana.create_annotation");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
  });

  // ── grafana.list_dashboards ────────────────────────────────────────────────

  it("list_dashboards forwards query + limit positionally and stringifies the array", async () => {
    const dashboards = [
      {
        id: 1,
        uid: "abc",
        title: "Prod",
        url: "/d/abc",
        tags: ["prod"],
        folderTitle: "Ops",
        folderId: 2,
      },
    ];
    getDashboards.mockResolvedValue(dashboards);

    const tool = getTool("grafana.list_dashboards");
    const out = await tool?.execute(makeContext({ query: "prod", limit: 10 }));

    expect(getDashboards).toHaveBeenCalledWith("prod", 10);
    expect(out).toBe(JSON.stringify(dashboards));
  });

  it("list_dashboards passes undefined for omitted / wrong-typed params", async () => {
    getDashboards.mockResolvedValue([]);

    const tool = getTool("grafana.list_dashboards");
    await tool?.execute(makeContext({ query: 123, limit: "nope" }));

    expect(getDashboards).toHaveBeenCalledWith(undefined, undefined);
  });

  // ── grafana.list_alert_rules ───────────────────────────────────────────────

  it("list_alert_rules forwards limit positionally and stringifies the array", async () => {
    const rules = [
      {
        uid: "r1",
        title: "High CPU",
        condition: "C",
        data: [],
        intervalSeconds: 60,
        orgId: 1,
        namespaceUID: "ns1",
        ruleGroup: "g1",
      },
    ];
    getAlertRules.mockResolvedValue(rules);

    const tool = getTool("grafana.list_alert_rules");
    const out = await tool?.execute(makeContext({ limit: 25 }));

    expect(getAlertRules).toHaveBeenCalledWith(25);
    expect(out).toBe(JSON.stringify(rules));
  });

  it("list_alert_rules passes undefined limit when omitted", async () => {
    getAlertRules.mockResolvedValue([]);

    const tool = getTool("grafana.list_alert_rules");
    await tool?.execute(makeContext({}));

    expect(getAlertRules).toHaveBeenCalledWith(undefined);
  });

  // ── grafana.create_annotation ──────────────────────────────────────────────

  it("create_annotation forwards positional args + options and stringifies the result", async () => {
    const created = { id: 99 };
    createAnnotation.mockResolvedValue(created);

    const tool = getTool("grafana.create_annotation");
    const out = await tool?.execute(
      makeContext({
        dashboardUid: "abc",
        panelId: 3,
        text: "deploy",
        tags: ["release"],
        time: 1000,
        timeEnd: 2000,
      }),
    );

    expect(createAnnotation).toHaveBeenCalledWith("abc", 3, "deploy", {
      tags: ["release"],
      time: 1000,
      timeEnd: 2000,
    });
    expect(out).toBe(JSON.stringify(created));
  });

  it("create_annotation passes undefined options for omitted optionals", async () => {
    createAnnotation.mockResolvedValue({ id: 1 });

    const tool = getTool("grafana.create_annotation");
    await tool?.execute(
      makeContext({ dashboardUid: "abc", panelId: 0, text: "x" }),
    );

    expect(createAnnotation).toHaveBeenCalledWith("abc", 0, "x", {
      tags: undefined,
      time: undefined,
      timeEnd: undefined,
    });
  });

  // ── grafana.query_datasource ───────────────────────────────────────────────

  it("query_datasource forwards uid/queries/from/to positionally and stringifies the result", async () => {
    const response = { results: { A: { frames: [] } } };
    queryDataSource.mockResolvedValue(response);

    const queries = [{ refId: "A", expr: "up" }];
    const tool = getTool("grafana.query_datasource");
    const out = await tool?.execute(
      makeContext({
        datasourceUid: "ds1",
        queries,
        from: "now-6h",
        to: "now",
      }),
    );

    expect(queryDataSource).toHaveBeenCalledWith(
      "ds1",
      queries,
      "now-6h",
      "now",
    );
    expect(out).toBe(JSON.stringify(response));
  });

  it("query_datasource defaults queries to [] and passes undefined from/to when omitted", async () => {
    queryDataSource.mockResolvedValue({ results: {} });

    const tool = getTool("grafana.query_datasource");
    await tool?.execute(makeContext({ datasourceUid: "ds1" }));

    expect(queryDataSource).toHaveBeenCalledWith(
      "ds1",
      [],
      undefined,
      undefined,
    );
  });
});
