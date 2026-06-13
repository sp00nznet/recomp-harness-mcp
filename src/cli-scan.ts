#!/usr/bin/env node
// Quick local sanity check: `npm run scan` prints the detected catalog without
// going through MCP. Useful for verifying the scanner against a real recomp tree.
import { scanHarnesses } from "./scanner.js";
import { DEFAULT_ROOT } from "./server.js";

async function main() {
  const root = process.argv[2] || DEFAULT_ROOT;
  const harnesses = await scanHarnesses(root);
  const byPlatform = new Map<string, number>();
  for (const h of harnesses) byPlatform.set(h.platform, (byPlatform.get(h.platform) ?? 0) + 1);

  console.log(`root: ${root}`);
  console.log(`harnesses: ${harnesses.length}\n`);
  for (const h of harnesses) {
    const tags = [h.type, h.status, h.builtExecutables.length ? "built" : ""].filter(Boolean).join(", ");
    console.log(`• ${h.id}  [${tags}]`);
    if (h.summary) console.log(`    ${h.summary.slice(0, 110)}`);
  }
  console.log("\nby platform:");
  for (const [p, n] of [...byPlatform].sort()) console.log(`  ${p}: ${n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
