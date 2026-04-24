import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-recipes-content-token-000000000000";

let server: Server | null = null;
let port = 0;

function makeRequest(
  options: http.RequestOptions,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

describe("Server recipe content routes", () => {
  it("returns raw recipe content for GET /recipes/:name", async () => {
    server!.loadRecipeContentFn = (name: string) =>
      name === "yaml-draft"
        ? {
            content:
              "name: yaml-draft\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: /tmp/out.txt\n    content: ok\n",
            path: "/tmp/yaml-draft.yaml",
          }
        : null;

    const { status, body } = await makeRequest({
      method: "GET",
      path: "/recipes/yaml-draft",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      content:
        "name: yaml-draft\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: /tmp/out.txt\n    content: ok\n",
      path: "/tmp/yaml-draft.yaml",
    });
  });

  it("saves raw recipe content for PUT /recipes/:name", async () => {
    let savedName = "";
    let savedContent = "";
    server!.saveRecipeContentFn = (name: string, content: string) => {
      savedName = name;
      savedContent = content;
      return { ok: true, path: `/tmp/${name}.yaml` };
    };

    const content =
      "name: yaml-draft\ntrigger:\n  type: manual\nsteps:\n  - tool: file.write\n    path: /tmp/out.txt\n    content: ok\n";

    const { status, body } = await makeRequest(
      {
        method: "PUT",
        path: "/recipes/yaml-draft",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ content }),
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      ok: true,
      path: "/tmp/yaml-draft.yaml",
    });
    expect(savedName).toBe("yaml-draft");
    expect(savedContent).toBe(content);
  });

  it("returns 400 when saveRecipeContentFn rejects invalid content", async () => {
    server!.saveRecipeContentFn = () => ({
      ok: false,
      error: "Step 1: Agent step missing 'prompt'",
    });

    const { status, body } = await makeRequest(
      {
        method: "PUT",
        path: "/recipes/yaml-draft",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ content: "name: yaml-draft\n" }),
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: "Step 1: Agent step missing 'prompt'",
    });
  });
});
