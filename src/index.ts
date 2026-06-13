#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, DEFAULT_ROOT } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostics go to stderr so stdout stays a clean JSON-RPC channel.
  process.stderr.write(`recomp-harness-mcp listening (root=${DEFAULT_ROOT})\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
