import https from "node:https";

/**
 * Shared https.Agent forcing IPv4-only connections for outbound Web Push
 * sends. Some local network configs (observed: Tailscale active without a
 * working native IPv6 uplink) inject unroutable AAAA records that make
 * Node's Happy Eyeballs dual-stack connect hang until ETIMEDOUT, even
 * though IPv4 to the same push endpoint (e.g. web.push.apple.com) works
 * fine. web-push has no global family override, so every sendNotification
 * call must pass this agent explicitly via the options argument.
 */
export const pushAgent = new https.Agent({ family: 4 });
