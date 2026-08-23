// Self-test: drives the MCP server through an in-memory MCP client against a
// running agent app. Usage: npm run selftest  (app must be running on AGENT_API_URL)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentMrServer } from "./server.js";

const API = process.env.AGENT_API_URL ?? "http://localhost:3000";
const server = createAgentMrServer({ apiUrl: API });

function connectPair(server: { connect(t: unknown): Promise<void> }, client: { connect(t: unknown): Promise<void> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
}

async function main() {
  const client = new Client({ name: "selftest", version: "0.0.1" });
  await connectPair(server, client);

  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}`);

  const spend = await client.callTool({ name: "spend_report", arguments: { days: 7 } });
  console.log("--- spend_report ---");
  console.log(String((spend.content as { text: string }[])[0]?.text ?? "").slice(0, 400));

  const pend = await client.callTool({ name: "list_pending_actions", arguments: {} });
  console.log("--- list_pending_actions ---");
  console.log(String((pend.content as { text: string }[])[0]?.text ?? "").slice(0, 300));

  const camps = await client.callTool({ name: "list_campaigns", arguments: { days: 7, status: "all" } });
  console.log("--- list_campaigns (first 3 lines) ---");
  console.log(String((camps.content as { text: string }[])[0]?.text ?? "").split("\n").slice(0, 4).join("\n"));

  await client.close();
  await server.close();
  console.log("\nSELFTEST OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("SELFTEST FAILED:", e);
  process.exit(1);
});
