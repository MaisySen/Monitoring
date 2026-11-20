#!/usr/bin/env node
// Writes the license and notice texts of every production npm dependency of the server and web UI (both are bundled
// into the shipped artifacts). Input: `pnpm licenses list --prod --json` on stdin. Usage:
//   pnpm licenses list --prod --json | node scripts/third-party-notices.mjs <output file>
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: pnpm licenses list --prod --json | node scripts/third-party-notices.mjs <output file>");
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const FILES = /^(licen[cs]e|copying|notice)(\..*|-.*)?$/i;
const parts = [
  "Monitoring server and web UI: third-party notices",
  "==============================================",
  "",
  "Monitoring is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).",
  "The server bundle and web UI include the npm packages below, each under its own license.",
  "",
];
const pkgs = Object.entries(data)
  .flatMap(([license, list]) => list.map((p) => ({ ...p, license })))
  .sort((a, b) => a.name.localeCompare(b.name));
let missing = 0;
for (const p of pkgs) {
  for (const [i, dir] of (p.paths ?? []).entries()) {
    const version = p.versions?.[i] ?? p.versions?.[0] ?? "";
    parts.push("=".repeat(80), `${p.name}@${version} (${p.license})${p.homepage ? ` ${p.homepage}` : ""}`, "");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => FILES.test(f)).sort() : [];
    for (const f of files) parts.push(`--- ${f}`, "", fs.readFileSync(path.join(dir, f), "utf8").trimEnd(), "");
    if (!files.length) {
      // a few packages ship their license only inside the README
      const readme = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^readme(\.md)?$/i.test(f)) : undefined;
      const text = readme ? fs.readFileSync(path.join(dir, readme), "utf8") : "";
      const m = /^#+\s*licen[cs]e\b.*\n([\s\S]*?)(?=^#+\s|\s*$(?![\s\S]))/im.exec(text);
      if (m && m[1].trim()) parts.push("--- license section of the package README", "", m[1].trim(), "");
      else {
        parts.push(`No license file is included in the published package. License: ${p.license}${p.license === "Apache-2.0" ? " (text in LICENSE)" : ""}.`, "");
        missing++;
      }
    }
  }
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, parts.join("\n") + "\n");
console.log(`wrote ${out}: ${pkgs.length} packages${missing ? `, ${missing} without license text in the package` : ""}`);
