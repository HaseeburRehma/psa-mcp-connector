#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { InMemoryPsa } from "./store.js";
import { SEED_TICKETS } from "./fixtures.js";

/**
 * One process per MSP client. The tenant comes from the environment the MSP
 * configures, never from a tool argument, so nothing the model reads in a
 * ticket can point it at another client's data.
 */
const tenantId = process.env.PSA_TENANT;
if (!tenantId) {
  console.error("Set PSA_TENANT to the client this server may access, e.g. PSA_TENANT=harbor-dental");
  process.exit(1);
}

const server = buildServer({
  tenantId,
  psa: new InMemoryPsa(SEED_TICKETS),
  allowWrites: process.env.PSA_ALLOW_WRITES === "true",
  audit: process.env.PSA_AUDIT_LOG,
});

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol; status messages go to stderr.
console.error(`psa-mcp-connector ready for tenant "${tenantId}" (writes ${process.env.PSA_ALLOW_WRITES === "true" ? "on" : "off"})`);
