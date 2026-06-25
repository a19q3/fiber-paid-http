import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { consoleIconComponents, consoleIconNames } from "../src/components/icons.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "..", "index.html");
const start = '<script id="lucide-icon-sprite" type="application/json">';
const end = "</script>";

const mode = process.argv.includes("--write") ? "write" : "check";
const sprite = Object.fromEntries(
  consoleIconNames.map((name) => {
    const Icon = consoleIconComponents[name];
    return [name, renderToStaticMarkup(<Icon />)];
  })
);
const encodedSprite = `${start}\n${JSON.stringify(sprite, null, 2)}\n${end}`;

const html = await readFile(htmlPath, "utf8");
const startIndex = html.indexOf(start);
const endIndex = html.indexOf(end, startIndex);

if (startIndex < 0 || endIndex < 0) {
  throw new Error("index.html must contain lucide-icon-sprite markers");
}

const current = html.slice(startIndex, endIndex + end.length);
if (current === encodedSprite) {
  console.log(`lucide-react icon sprite current: ${consoleIconNames.length} icons`);
  process.exit(0);
}

if (mode === "check") {
  throw new Error("lucide-react icon sprite is stale; run pnpm --filter @fiber-mpp/evidence-web sync-icons");
}

await writeFile(htmlPath, `${html.slice(0, startIndex)}${encodedSprite}${html.slice(endIndex + end.length)}`);
console.log(`lucide-react icon sprite wrote: ${consoleIconNames.length} icons`);
