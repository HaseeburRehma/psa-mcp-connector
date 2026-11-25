import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync } from "node:fs";
import { DEFAULT_POLICY, redact, type Finding, type Policy } from "./redact.js";
import type { PsaAdapter, Ticket } from "./types.js";

export interface ConnectorConfig {
  /** Fixed when the server starts. The model never chooses the tenant. */
  tenantId: string;
  psa: PsaAdapter;
  policy?: Policy;
  /** add_internal_note is only registered when this is true. */
  allowWrites?: boolean;
  /** Path of a JSON-lines audit log, or a function that receives each entry. */
  audit?: string | ((entry: AuditEntry) => void);
  now?: () => Date;
}

export interface AuditEntry {
  ts: string;
  tenant: string;
  tool: string;
  ticket_id?: number;
  outcome: "ok" | "not_found" | "blocked" | "rejected";
  findings: Finding[];
}

const STATUS = z.enum(["new", "in_progress", "waiting_on_client", "resolved"]);
const PRIORITY = z.enum(["low", "medium", "high", "critical"]);

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function error(message: string) {
  return { ...text(message), isError: true };
}

export function buildServer(cfg: ConnectorConfig): McpServer {
  const policy = cfg.policy ?? DEFAULT_POLICY;
  const now = cfg.now ?? (() => new Date());
  const server = new McpServer({ name: "psa-mcp-connector", version: "0.1.0" });

  const log = (entry: Omit<AuditEntry, "ts" | "tenant">) => {
    const full: AuditEntry = { ts: now().toISOString(), tenant: cfg.tenantId, ...entry };
    if (typeof cfg.audit === "function") cfg.audit(full);
    else if (typeof cfg.audit === "string") appendFileSync(cfg.audit, JSON.stringify(full) + "\n");
  };

  /** Everything leaving the server goes through here: one place to redact. */
  const release = (payload: unknown, tool: string, ticketId?: number) => {
    const r = redact(JSON.stringify(payload, null, 2), policy);
    if (r.blocked.length) {
      log({ tool, ticket_id: ticketId, outcome: "blocked", findings: r.findings });
      return error(
        `Blocked by the data policy for this client: the result contains ${r.blocked.join(", ")}. ` +
          "Ask a technician to review the ticket directly.",
      );
    }
    log({ tool, ticket_id: ticketId, outcome: "ok", findings: r.findings });
    return text(r.text);
  };

  const summary = (t: Ticket) => ({
    id: t.id,
    summary: t.summary,
    status: t.status,
    priority: t.priority,
    created_at: t.created_at,
  });

  server.registerTool(
    "list_open_tickets",
    {
      title: "List open tickets",
      description: "List this client's tickets that are not resolved, newest first. Returns id, summary, status and priority only.",
      inputSchema: {
        priority: z.array(PRIORITY).optional().describe("Only these priorities"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ priority, limit }) => {
      const open = await cfg.psa.listTickets(cfg.tenantId, {
        status: ["new", "in_progress", "waiting_on_client"],
        priority,
      });
      open.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return release(open.slice(0, limit).map(summary), "list_open_tickets");
    },
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get ticket",
      description: "Full details and notes of one ticket of this client. Personal data is masked; tickets with card numbers or secrets are withheld.",
      inputSchema: { ticket_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ ticket_id }) => {
      const t = await cfg.psa.getTicket(cfg.tenantId, ticket_id);
      if (!t) {
        log({ tool: "get_ticket", ticket_id, outcome: "not_found", findings: [] });
        return error(`Ticket ${ticket_id} was not found for this client.`);
      }
      const { tenant_id: _omit, ...visible } = t;
      return release(visible, "get_ticket", ticket_id);
    },
  );

  server.registerTool(
    "search_tickets",
    {
      title: "Search tickets",
      description: "Search this client's tickets (summary, details and notes) for a phrase.",
      inputSchema: { query: z.string().min(2).max(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const found = await cfg.psa.searchTickets(cfg.tenantId, query);
      // Match against what the model is allowed to see. Otherwise searching
      // for a guessed password would reveal which ticket contains it.
      const q = query.toLowerCase();
      const visible = found.filter((t) =>
        redact(`${t.summary}\n${t.details}\n${t.notes.map((n) => n.body).join("\n")}`, policy).text.toLowerCase().includes(q),
      );
      return release(visible.map(summary), "search_tickets");
    },
  );

  if (cfg.allowWrites) {
    server.registerTool(
      "add_internal_note",
      {
        title: "Add internal note",
        description: "Add an internal (technician-only) note to one of this client's tickets. Notes containing card numbers or secrets are rejected.",
        inputSchema: {
          ticket_id: z.number().int().positive(),
          note: z.string().min(1).max(2000),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ ticket_id, note }) => {
        // The same policy applies on the way in: an agent must not paste a
        // secret it saw elsewhere into the ticket system.
        const r = redact(note, policy);
        if (r.blocked.length) {
          log({ tool: "add_internal_note", ticket_id, outcome: "rejected", findings: r.findings });
          return error(`Note rejected: it contains ${r.blocked.join(", ")}.`);
        }
        const t = await cfg.psa.addNote(cfg.tenantId, ticket_id, {
          author: "ai-agent",
          internal: true,
          created_at: now().toISOString(),
          body: r.text,
        });
        if (!t) {
          log({ tool: "add_internal_note", ticket_id, outcome: "not_found", findings: r.findings });
          return error(`Ticket ${ticket_id} was not found for this client.`);
        }
        log({ tool: "add_internal_note", ticket_id, outcome: "ok", findings: r.findings });
        return text(`Internal note added to ticket ${ticket_id}.`);
      },
    );
  }

  return server;
}
