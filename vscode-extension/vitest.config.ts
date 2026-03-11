import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/__tests__/__mocks__/vscode.ts"),
    },
  },
});
