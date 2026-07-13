import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const aliases = {
  "@fiber-paid-http/core": resolve(root, "packages/core/src/index.ts"),
  "@fiber-paid-http/storage": resolve(root, "packages/storage/src/index.ts"),
  "@fiber-paid-http/fiber-method": resolve(root, "packages/fiber-method/src/index.ts"),
  "@fiber-paid-http/f402-compat": resolve(root, "packages/f402-compat/src/index.ts"),
  "@fiber-paid-http/x402-compat": resolve(root, "packages/x402-compat/src/index.ts"),
  "@fiber-paid-http/fl402-compat": resolve(root, "packages/fl402-compat/src/index.ts"),
  "@fiber-paid-http/server-middleware": resolve(root, "packages/server-middleware/src/index.ts"),
  "@fiber-paid-http/client": resolve(root, "packages/client/src/index.ts"),
  "@fiber-paid-http/evidence-api": resolve(root, "apps/evidence-api/src/index.ts")
};

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node"
  },
  resolve: {
    alias: aliases
  }
});
