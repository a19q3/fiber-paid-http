import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const blockedTerm = `${"mo"}${"ck"}`;
const removedContractTerms = [
  `${"leg"}${"acy"}`,
  `${"receipt"}${"Id"}`,
  `${"receipt"}_${"id"}`,
  `${"FIBER"}_${"MPP"}`,
  `${"fiber"}_${"mpp"}`,
  `${"fl402"}-${"macaroon"}`,
  `${"signed"} ${"receipt"}`,
  `${"signed"} ${"challenge"}`
];
const scanRoots = [
  "AGENTS.md",
  "README.md",
  "apps",
  "crates",
  "docs",
  "examples",
  "packages",
  "scripts",
  "tests"
];
const ignoredDirectories = new Set([
  ".git",
  ".tmp",
  ".crush",
  "dist",
  "node_modules",
  "target"
]);
const ignoredFiles = new Set([
  "pnpm-lock.yaml",
  "tests/unit/no-offline-payment-surface.test.ts"
]);
const scannedExtensions = new Set([
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);

describe("product surface wording", () => {
  it("does not reintroduce offline payment adapter language", async () => {
    const files = await collectScannedFiles();
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(join(repoRoot, file), "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(blockedTerm)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("does not reintroduce removed protocol contracts", async () => {
    const files = await collectScannedFiles();
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(join(repoRoot, file), "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const term of removedContractTerms) {
          if (line.toLowerCase().includes(term.toLowerCase())) {
            violations.push(`${file}:${index + 1}: ${term}: ${line.trim()}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});

async function collectScannedFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of scanRoots) {
    await collect(root, files);
  }
  return files.sort();
}

async function collect(relativePath: string, files: string[]): Promise<void> {
  if (ignoredFiles.has(relativePath)) {
    return;
  }
  const absolutePath = join(repoRoot, relativePath);
  const info = await stat(absolutePath).catch(() => null);
  if (!info) {
    return;
  }
  if (info.isDirectory()) {
    const name = relativePath.split("/").at(-1) ?? relativePath;
    if (ignoredDirectories.has(name)) {
      return;
    }
    const entries = await readdir(absolutePath);
    for (const entry of entries) {
      await collect(join(relativePath, entry), files);
    }
    return;
  }
  if (info.isFile() && shouldScanFile(relativePath)) {
    files.push(relativePath);
  }
}

function shouldScanFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  return scannedExtensions.has(path.slice(dot));
}
