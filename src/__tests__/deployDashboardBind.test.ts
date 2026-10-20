/**
 * deploy/deploy-dashboard.sh starts the dashboard reachable ONLY through the
 * local reverse proxy, and tells it to trust that proxy's client address
 * (Private/52 LOW, owner decision 2026-10-20).
 *
 * The login lockout keys on the client IP only when BRIDGE_TRUST_PROXY=true
 * (`dashboard/src/lib/clientIp.ts`); nothing shipped set it, so every client
 * shared one global bucket and anyone could lock everyone out. Trusting
 * `X-Real-IP` is only safe when no client can reach the app except through
 * nginx — so the two changes ship together: bind 127.0.0.1, then trust.
 *
 * Runs the script's REMOTE section for real (bash, its own text), with `pm2`
 * stubbed to record the environment it was started with.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "deploy", "deploy-dashboard.sh");

function remoteSection(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("<<'REMOTE'\n");
  const end = src.indexOf("\nREMOTE\n", start);
  if (start < 0 || end < 0) throw new Error("REMOTE heredoc not found");
  return src.slice(start + "<<'REMOTE'\n".length, end + 1);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-dashboard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runRemote(): Record<string, string> {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const record = join(dir, "pm2-start.env");
  // pm2: `list` prints nothing; `start` records the env it was given.
  writeFileSync(
    join(bin, "pm2"),
    `#!/bin/sh\ncase "$1" in\n  start) env > "${record}" ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(bin, "pm2"), 0o755);
  const tarball = join(dir, "dash.tar.gz");
  const payload = join(dir, "payload");
  mkdirSync(payload);
  writeFileSync(join(payload, "server.js"), "");
  spawnSync("tar", ["-czf", tarball, "-C", payload, "."]);
  const remoteDir = join(dir, "remote");
  const r = spawnSync(
    "bash",
    [
      "-s",
      "--",
      "tok",
      "pw",
      remoteDir,
      "patchwork-dashboard",
      "3200",
      "https://bridge.example.test",
      "mailto:ops@example.test",
      tarball,
    ],
    {
      input: remoteSection(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  expect(r.status, r.stderr).toBe(0);
  const env: Record<string, string> = {};
  for (const line of readFileSync(record, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

describe.skipIf(process.platform === "win32")("deploy-dashboard.sh", () => {
  it("starts the dashboard bound to loopback", () => {
    expect(runRemote().HOSTNAME).toBe("127.0.0.1");
  });

  it("trusts the proxy's client address, so the lockout is per client", () => {
    expect(runRemote().BRIDGE_TRUST_PROXY).toBe("true");
  });

  it("still starts it on the configured port", () => {
    expect(runRemote().PORT).toBe("3200");
  });
});
