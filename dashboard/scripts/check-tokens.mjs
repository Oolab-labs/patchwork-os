#!/usr/bin/env node
// Verify every token in tokens.json matches its CSS custom property in
// src/app/globals.css. tokens.json is curated (semantic groupings, drops noise
// like --card-bg / --paper-grain) so we don't auto-generate it — but drift is
// silent and load-bearing. This check fails CI when a value moves in CSS but
// the JSON wasn't updated, or vice versa.
//
// Usage: node scripts/check-tokens.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS_PATH = join(ROOT, "src/app/globals.css");
const JSON_PATH = join(ROOT, "tokens.json");

function parseVarsBlock(css, selector) {
  // Match the first occurrence of `selector { ... }` at top-level and pull
  // every `--name: value;` declaration. The selector regex is intentionally
  // anchored at line start to skip nested rules like `[data-theme="dark"] .x`.
  const re = new RegExp(`^${selector}\\s*{([^}]*)}`, "m");
  const m = css.match(re);
  if (!m) throw new Error(`could not find selector block: ${selector}`);
  const body = m[1];
  const vars = {};
  const declRe = /--([\w-]+)\s*:\s*([^;]+?)\s*;/g;
  let d;
  while ((d = declRe.exec(body)) !== null) {
    vars[d[1]] = d[2].trim();
  }
  return vars;
}

function normalize(v) {
  // Collapse internal whitespace so trivial reformatting doesn't trip the check.
  return String(v).replace(/\s+/g, " ").trim();
}

const css = readFileSync(CSS_PATH, "utf8");
const tokens = JSON.parse(readFileSync(JSON_PATH, "utf8"));

const lightVars = parseVarsBlock(css, ":root");
const darkVars = parseVarsBlock(css, '\\[data-theme="dark"\\]');

const themes = [
  { name: "light", json: tokens.light, css: lightVars },
  { name: "dark", json: tokens.dark, css: darkVars },
];

const mismatches = [];
const missingInCss = [];

// Tokens whose JSON name doesn't match CSS variable name 1:1. Most do.
const RENAMES = {
  "radius.default": "radius",
  "spacing.1": "s-1",
  "spacing.2": "s-2",
  "spacing.3": "s-3",
  "spacing.4": "s-4",
  "spacing.5": "s-5",
  "spacing.6": "s-6",
  "spacing.8": "s-8",
  "spacing.10": "s-10",
  "spacing.12": "s-12",
  "spacing.16": "s-16",
  "radius.s": "r-s",
  "radius.m": "r-m",
  "radius.l": "r-l",
  "radius.xl": "r-xl",
  "radius.1": "r-1",
  "radius.2": "r-2",
  "radius.3": "r-3",
  "radius.4": "r-4",
  "radius.full": "r-full",
  "shadow.s": "shadow-s",
  "shadow.m": "shadow-m",
  "shadow.l": "shadow-l",
  "font.sans": "font-sans",
  "font.serif": "font-serif",
  "font.mono": "font-mono",
};

for (const { name: themeName, json, css: cssVars } of themes) {
  if (!json) continue;
  for (const [groupName, group] of Object.entries(json)) {
    if (typeof group !== "object" || group === null) continue;
    for (const [tokenName, jsonValue] of Object.entries(group)) {
      const renameKey = `${groupName}.${tokenName}`;
      const cssVarName = RENAMES[renameKey] ?? tokenName;
      const cssValue = cssVars[cssVarName];
      if (cssValue === undefined) {
        missingInCss.push(`[${themeName}] ${groupName}.${tokenName} → --${cssVarName} not defined in CSS`);
        continue;
      }
      if (normalize(cssValue) !== normalize(jsonValue)) {
        mismatches.push(
          `[${themeName}] ${groupName}.${tokenName}\n  json: ${jsonValue}\n  css : ${cssValue}`,
        );
      }
    }
  }
}

if (mismatches.length === 0 && missingInCss.length === 0) {
  console.log(`tokens.json matches globals.css (${Object.keys(lightVars).length} light vars, ${Object.keys(darkVars).length} dark vars)`);
  process.exit(0);
}

if (mismatches.length > 0) {
  console.error(`\n✗ ${mismatches.length} token mismatch(es) between tokens.json and globals.css:\n`);
  for (const m of mismatches) console.error(`  ${m}\n`);
}
if (missingInCss.length > 0) {
  console.error(`\n✗ ${missingInCss.length} token(s) in tokens.json with no matching CSS variable:\n`);
  for (const m of missingInCss) console.error(`  ${m}`);
  console.error("");
}
console.error("Update tokens.json to match globals.css, or vice versa, then re-run.");
process.exit(1);
