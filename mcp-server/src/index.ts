#!/usr/bin/env node
// MCP server entrypoint (stdio).
// Run:  AGENT_API_URL=http://localhost:3000 node dist/index.js
// MCP client config example:
//   { "mcpServers": { "agent-mr": { "command": "node", "args": ["dist/index.js"], "env": { "AGENT_API_URL": "http://localhost:3000" } } }

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentMrServer } from "./server.js";

const server = createAgentMrServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[agent-mr mcp] ready, proxying ${process.env.AGENT_API_URL ?? "http://localhost:3000"}`);
