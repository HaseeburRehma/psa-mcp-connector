/**
 * Starts the real server as a child process over stdio, exactly as an MCP
 * client (Claude Desktop, an agent runtime) would, and makes the calls an
 * agent would make. Prints what the model would see.
 *
 *   npm run demo
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const auditPath = join(mkdtempSync(join(tmpdir(), "psa-demo-")), "audit.jsonl");

async function session(tenant: string, allowWrites: boolean) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "index.js")],
    env: {
      ...(process.env as Record<string, string>),
      PSA_TENANT: tenant,
      PSA_ALLOW_WRITES: String(allowWrites),
      PSA_AUDIT_LOG: auditPath,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "demo-agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function show(title: string, result: unknown) {
  const r = result as { content?: { text?: string }[]; isError?: boolean };
  const body = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`\n── ${title}${r.isError ? "  [error returned to the model]" : ""}`);
  console.log(body.split("\n").map((l) => "   " + l).join("\n"));
}

const dental = await session("harbor-dental", true);
const tools = await dental.listTools();
console.log("Tools offered to the model (harbor-dental, writes on):", tools.tools.map((t) => t.name).join(", "));

show("list_open_tickets", await dental.callTool({ name: "list_open_tickets", arguments: {} }));
show("get_ticket 1001: phone and email masked", await dental.callTool({ name: "get_ticket", arguments: { ticket_id: 1001 } }));
show("get_ticket 1002: card number masked, order ref kept", await dental.callTool({ name: "get_ticket", arguments: { ticket_id: 1002 } }));
show("get_ticket 1003: contains a password, so it is withheld", await dental.callTool({ name: "get_ticket", arguments: { ticket_id: 1003 } }));
show("get_ticket 2001: another client's ticket", await dental.callTool({ name: "get_ticket", arguments: { ticket_id: 2001 } }));
show(
  "add_internal_note with a pasted key: rejected",
  await dental.callTool({ name: "add_internal_note", arguments: { ticket_id: 1001, note: "Used key AKIAIOSFODNN7EXAMPLE to test" } }),
);
show(
  "add_internal_note: accepted, email masked on the way in",
  await dental.callTool({ name: "add_internal_note", arguments: { ticket_id: 1001, note: "Reinstalled the viewer; confirmed with maria.lopez@harbor-dental.example.com" } }),
);
await dental.close();

const law = await session("lakeside-law", false);
const lawTools = await law.listTools();
console.log("\nTools offered to the model (lakeside-law, writes off):", lawTools.tools.map((t) => t.name).join(", "));
show("get_ticket 2001: AWS key in the ticket, so it is withheld (and its injected instruction never reaches the model)", await law.callTool({ name: "get_ticket", arguments: { ticket_id: 2001 } }));
show("search_tickets 'outlook'", await law.callTool({ name: "search_tickets", arguments: { query: "outlook" } }));
show("get_ticket 2002: international phone masked", await law.callTool({ name: "get_ticket", arguments: { ticket_id: 2002 } }));
await law.close();

console.log("\n── Audit log (one line per call)");
for (const line of readFileSync(auditPath, "utf8").trim().split("\n")) {
  const e = JSON.parse(line);
  const f = e.findings.map((x: { type: string; count: number }) => `${x.type}×${x.count}`).join(" ") || "-";
  console.log(`   ${e.tenant.padEnd(14)} ${e.tool.padEnd(18)} ${String(e.ticket_id ?? "").padEnd(5)} ${e.outcome.padEnd(9)} ${f}`);
}
