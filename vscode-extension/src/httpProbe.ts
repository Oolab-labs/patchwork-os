import * as http from "node:http";

/**
 * Ping the bridge HTTP server to verify it is listening and responsive.
 * Uses the unauthenticated /ping endpoint so no auth token is required.
 * Returns true if the server responds with HTTP 200, false otherwise.
 * Never throws — all errors are caught and mapped to false.
 */
export function pingBridge(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/ping`,
      { timeout: 3000 },
      (res) => {
        resolve(res.statusCode === 200);
        res.resume(); // drain to prevent socket leak
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
