import { defineConfig } from "vitest/config";

export const aliases = {
  "@fiber-mpp/core": "/home/arthur/a19q3/fiber-mpp/packages/core/src/index.ts",
  "@fiber-mpp/storage": "/home/arthur/a19q3/fiber-mpp/packages/storage/src/index.ts",
  "@fiber-mpp/fiber-method": "/home/arthur/a19q3/fiber-mpp/packages/fiber-method/src/index.ts",
  "@fiber-mpp/f402-compat": "/home/arthur/a19q3/fiber-mpp/packages/f402-compat/src/index.ts",
  "@fiber-mpp/server-middleware": "/home/arthur/a19q3/fiber-mpp/packages/server-middleware/src/index.ts",
  "@fiber-mpp/client": "/home/arthur/a19q3/fiber-mpp/packages/client/src/index.ts",
  "@fiber-mpp/demo-api": "/home/arthur/a19q3/fiber-mpp/apps/demo-api/src/index.ts"
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
