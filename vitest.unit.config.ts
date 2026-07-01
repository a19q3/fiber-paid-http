import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const aliases = {
  "@fiber-mpp/core": resolve(root, "packages/core/src/index.ts"),
  "@fiber-mpp/storage": resolve(root, "packages/storage/src/index.ts"),
  "@fiber-mpp/fiber-method": resolve(root, "packages/fiber-method/src/index.ts"),
  "@fiber-mpp/f402-compat": resolve(root, "packages/f402-compat/src/index.ts"),
  "@fiber-mpp/fl402-compat": resolve(root, "packages/fl402-compat/src/index.ts"),
  "@fiber-mpp/server-middleware": resolve(root, "packages/server-middleware/src/index.ts"),
  "@fiber-mpp/client": resolve(root, "packages/client/src/index.ts"),
  "@fiber-mpp/evidence-api": resolve(root, "apps/evidence-api/src/index.ts")
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
