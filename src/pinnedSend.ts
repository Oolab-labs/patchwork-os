/**
 * The one outbound path for the bridge's notification senders — approval
 * webhook, push send, push dismiss, halt push and both ntfy calls.
 *
 * Security sweep 2026-10-01, L3. Each sender used to resolve DNS, check the
 * answer, and then call bare `fetch`, which resolved the name AGAIN: a
 * DNS-rebinding window between the check and the connection. They also let
 * `fetch` follow redirects with no re-validation. They were the last outbound
 * sinks not on `safeFetch`.
 *
 * Two deliberate differences from `safeFetch`'s defaults, both inherited from
 * the senders' own check and both STRICTER:
 *   - ALL addresses are resolved and the send is refused if ANY is private
 *     (safeFetch resolves one), and
 *   - a DNS failure refuses the send (safeFetch proceeds unpinned and lets the
 *     transport report it).
 * The address this check accepted then becomes the pin, via a fixed resolver,
 * so nothing resolves the name a second time.
 *
 * Redirects are NOT followed. A push relay, approval webhook or ntfy server
 * has no reason to redirect a POST, and following one is a way to be steered
 * after the check. A 3xx comes back to the caller as a non-2xx response.
 *
 * Returns `null` when the send was refused before any connection was made
 * (already warned with `[label]`). Transport errors propagate, so each
 * caller's existing catch-and-warn keeps working unchanged.
 */

import * as dnsNs from "node:dns/promises";
import { isPrivateHost } from "./privateHost.js";
import { safeFetch } from "./ssrfGuard.js";

export interface PinnedSendInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface PinnedSendOptions {
  /** Log prefix, e.g. "push" → `[push] …`. */
  label: string;
  /** Operator opt-in to private targets; the address is still pinned. */
  allowPrivate?: boolean;
}

/**
 * The module's default object when it has a usable `lookup`, else the
 * namespace. The read is guarded because vitest's module-mock proxy THROWS on
 * access to an export the mock factory did not define — an unguarded
 * `.default` read escaped the DNS try/catch and every send failed.
 */
function dnsApi(): Pick<typeof dnsNs, "lookup"> {
  try {
    const d = (dnsNs as unknown as { default?: typeof dnsNs }).default;
    if (d && typeof d.lookup === "function") return d;
  } catch {
    // mocked module without a default export
  }
  return dnsNs;
}

export async function pinnedSend(
  url: string,
  init: PinnedSendInit,
  opts: PinnedSendOptions,
): Promise<Response | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    console.warn(`[${opts.label}] Malformed URL — skipping`);
    return null;
  }

  // Resolved at call time through the module's default object when it has
  // one, else the namespace. In production both are the same `lookup`. The
  // distinction is for tests: some suites `vi.spyOn(dns, "lookup")` on the
  // DEFAULT object (which a namespace binding would not see), others
  // `vi.mock("node:dns/promises", () => ({ lookup }))` with NO default (which
  // a default import would see as undefined — and then every send would be
  // refused, fail-closed, looking exactly like a DNS outage).
  const dns = dnsApi();
  let addresses: Array<{ address: string }>;
  try {
    const r = await dns.lookup(hostname, { all: true });
    // `{ all: true }` always yields an array; coerce defensively so a mock
    // that returns one LookupAddress cannot make this throw and fail open.
    addresses = Array.isArray(r) ? r : [r as { address: string }];
  } catch (err) {
    console.warn(
      `[${opts.label}] DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const first = addresses[0]?.address;
  if (first === undefined) {
    console.warn(`[${opts.label}] DNS returned no address for ${hostname}`);
    return null;
  }
  if (!opts.allowPrivate) {
    const blocked = addresses.find((a) => isPrivateHost(a.address));
    if (blocked) {
      console.warn(
        `[${opts.label}] Blocked private/loopback IP: ${blocked.address}`,
      );
      return null;
    }
  }

  const { response } = await safeFetch(
    url,
    { ...init },
    {
      allowPrivate: opts.allowPrivate,
      // The address checked above IS the pin: no second resolution, so no
      // rebinding window between check and connect.
      resolveDns: async () => first,
      followRedirects: false,
    },
  );
  return response;
}
