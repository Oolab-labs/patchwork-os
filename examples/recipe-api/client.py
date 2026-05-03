#!/usr/bin/env python3
"""
Patchwork OS — minimal Python recipe API client.

Usage:
    BRIDGE_TOKEN=$(patchwork print-token) python3 client.py

Or inline:
    BRIDGE_TOKEN=<token> python3 client.py

Requires Python 3.8+ (uses urllib only — no third-party deps).
"""

import json
import os
import time
import urllib.request
from typing import Any, Optional
from urllib.error import HTTPError

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://localhost:3100")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")

if not BRIDGE_TOKEN:
    raise SystemExit(
        "Set BRIDGE_TOKEN env var.\n"
        "Run: BRIDGE_TOKEN=$(patchwork print-token) python3 client.py"
    )


def bridge_request(
    path: str,
    method: str = "GET",
    body: Optional[dict] = None,
) -> Any:
    """Authenticated request to the bridge. Returns parsed JSON."""
    url = f"{BRIDGE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        raise RuntimeError(
            f"Bridge {method} {path} → {e.code}: {e.read().decode()}"
        ) from e


# ── List recipes ──────────────────────────────────────────────────────────────

result = bridge_request("/recipes")
print("Installed recipes:", [r["name"] for r in result.get("recipes", [])])

# ── Run a recipe ──────────────────────────────────────────────────────────────

run_result = bridge_request("/recipes/run", method="POST", body={"name": "morning-brief"})
print("Run result:", run_result)

# Run with variables
run_with_vars = bridge_request(
    "/recipes/run",
    method="POST",
    body={"name": "capture-thought", "vars": {"thought": "Add dark mode to the dashboard"}},
)
print("Run with vars:", run_with_vars)

# ── Check recent runs ─────────────────────────────────────────────────────────

runs = bridge_request("/runs?limit=5")
for r in runs:
    print(f"  run #{r['seq']} {r['recipe']} → {r['status']}")

# ── Check pending approvals ───────────────────────────────────────────────────

approvals = bridge_request("/approvals")
print(f"Pending approvals: {len(approvals)}")
for a in approvals:
    print(f"  [{a['id']}] {a.get('tool')}({a.get('specifier', '')})")


def run_and_wait(name: str, vars: Optional[dict] = None, timeout_s: int = 60) -> dict:
    """Run a recipe and poll until completion. Returns the finished run record."""
    result = bridge_request("/recipes/run", method="POST", body={"name": name, "vars": vars})
    seq = result.get("seq")
    if not seq:
        return result

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        time.sleep(1.5)
        run = bridge_request(f"/runs/{seq}")
        status = run.get("status")
        if status == "done":
            return run
        if status == "error":
            raise RuntimeError(f"Recipe failed: {run.get('error', 'unknown')}")
        if status == "awaiting_approval":
            print("Waiting for human approval...")

    raise TimeoutError(f"Timed out waiting for run #{seq}")


# Uncomment to use:
# result = run_and_wait("morning-brief")
# print("Output:", result.get("output"))
