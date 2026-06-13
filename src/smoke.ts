// Standalone smoke test: spins up the server in-process over an in-memory
// transport pair and exercises the tools end-to-end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(clientT);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const list = await client.callTool({ name: "list_harnesses", arguments: { platform: "lynx" } });
  console.log("\nlist_harnesses(lynx):");
  console.log((list.content as any[])[0].text);

  const desc = await client.callTool({ name: "describe_harness", arguments: { id: "flow", readme: false } });
  const parsed = JSON.parse((desc.content as any[])[0].text);
  console.log("\ndescribe_harness(flow) commands:", JSON.stringify(parsed.commands));
  console.log("flow built exes:", parsed.builtExecutables);

  await client.close();
  await server.close();
  console.log("\nOK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
