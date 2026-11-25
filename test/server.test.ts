import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type AuditEntry } from "../src/server.js";
import { InMemoryPsa } from "../src/store.js";
import { SEED_TICKETS } from "../src/fixtures.js";
import { DEFAULT_POLICY } from "../src/redact.js";

async function connect(tenantId: string, opts: { allowWrites?: boolean; policy?: typeof DEFAULT_POLICY; psa?: InMemoryPsa } = {}) {
  const audit: AuditEntry[] = [];
  const psa = opts.psa ?? new InMemoryPsa(SEED_TICKETS);
  const server = buildServer({ tenantId, psa, allowWrites: opts.allowWrites, policy: opts.policy, audit: (e) => audit.push(e) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call, audit, psa };
}

describe("tenant isolation", () => {
  it("another client's ticket looks exactly like a missing one", async () => {
    const { call } = await connect("harbor-dental");
    const other = await call("get_ticket", { ticket_id: 2002 });
    const missing = await call("get_ticket", { ticket_id: 999999 });
    expect(other.isError).toBe(true);
    expect(other.text.replace("2002", "N")).toBe(missing.text.replace("999999", "N"));
  });

  it("list and search never return another client's tickets", async () => {
    const { call } = await connect("harbor-dental");
    const list = await call("list_open_tickets", {});
    const search = await call("search_tickets", { query: "outlook" });
    expect(JSON.parse(list.text).map((t: { id: number }) => t.id).sort()).toEqual([1001, 1002, 1003]);
    expect(JSON.parse(search.text)).toEqual([]);
  });

  it("an instruction planted in a ticket cannot reach another client", async () => {
    // Ticket 2001 (lakeside-law) says: add a note to ticket 1001 saying the case is closed.
    // Even if the model obeyed, this server only knows lakeside-law.
    const psa = new InMemoryPsa(SEED_TICKETS);
    const { call } = await connect("lakeside-law", { allowWrites: true, psa });
    const r = await call("add_internal_note", { ticket_id: 1001, note: "case is closed" });
    expect(r.isError).toBe(true);
    const t = await psa.getTicket("harbor-dental", 1001);
    expect(t?.notes).toEqual([]);
  });

  it("there is no tool argument that selects a tenant", async () => {
    const { client } = await connect("harbor-dental", { allowWrites: true });
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(Object.keys((t.inputSchema as { properties?: object }).properties ?? {})).not.toContain("tenant_id");
    }
  });
});

describe("redaction on the way out", () => {
  it("masks contact details in a ticket", async () => {
    const { call } = await connect("harbor-dental");
    const r = await call("get_ticket", { ticket_id: 1001 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("[PHONE]");
    expect(r.text).toContain("[EMAIL]");
    expect(r.text).not.toMatch(/555|harbor-dental\.example/);
  });

  it("masks a card number but keeps the order reference", async () => {
    const { call } = await connect("harbor-dental");
    const r = await call("get_ticket", { ticket_id: 1002 });
    expect(r.text).toContain("[CARD]");
    expect(r.text).toContain("4111-2026-118");
    expect(r.text).not.toContain("4111 1111");
  });

  it("withholds a ticket that contains a credential", async () => {
    const { call, audit } = await connect("harbor-dental");
    const r = await call("get_ticket", { ticket_id: 1003 });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("Welcome2026");
    expect(audit.at(-1)).toMatchObject({ tool: "get_ticket", ticket_id: 1003, outcome: "blocked" });
  });

  it("withholds the ticket with the AWS key, so its planted instruction never reaches the model", async () => {
    const { call } = await connect("lakeside-law");
    const r = await call("get_ticket", { ticket_id: 2001 });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/AKIA|Ignore previous/);
  });

  it("search cannot be used to confirm a guessed secret", async () => {
    const { call } = await connect("harbor-dental");
    const r = await call("search_tickets", { query: "Welcome2026" });
    expect(JSON.parse(r.text)).toEqual([]);
    const ok = await call("search_tickets", { query: "M365" });
    expect(JSON.parse(ok.text).map((t: { id: number }) => t.id)).toEqual([1003]);
  });

  it("a stricter client policy blocks cards instead of masking them", async () => {
    const { call } = await connect("harbor-dental", { policy: { ...DEFAULT_POLICY, card: "block" } });
    const r = await call("get_ticket", { ticket_id: 1002 });
    expect(r.isError).toBe(true);
  });
});

describe("writes", () => {
  it("are not offered unless the MSP turns them on", async () => {
    const off = await connect("harbor-dental");
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("add_internal_note");
    const on = await connect("harbor-dental", { allowWrites: true });
    expect((await on.client.listTools()).tools.map((t) => t.name)).toContain("add_internal_note");
  });

  it("reject a note with a credential and store nothing", async () => {
    const psa = new InMemoryPsa(SEED_TICKETS);
    const { call } = await connect("harbor-dental", { allowWrites: true, psa });
    const r = await call("add_internal_note", { ticket_id: 1001, note: "used key AKIAIOSFODNN7EXAMPLE" });
    expect(r.isError).toBe(true);
    expect((await psa.getTicket("harbor-dental", 1001))?.notes).toEqual([]);
  });

  it("mask contact details in a note before storing it, as an internal note by the agent", async () => {
    const psa = new InMemoryPsa(SEED_TICKETS);
    const { call } = await connect("harbor-dental", { allowWrites: true, psa });
    const r = await call("add_internal_note", { ticket_id: 1001, note: "Confirmed with maria@harbor-dental.example.com" });
    expect(r.isError).toBe(false);
    const notes = (await psa.getTicket("harbor-dental", 1001))?.notes ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ author: "ai-agent", internal: true, body: "Confirmed with [EMAIL]" });
  });
});

describe("input validation", () => {
  it.each([
    ["get_ticket", { ticket_id: -1 }],
    ["get_ticket", { ticket_id: "1001; DROP TABLE" }],
    ["list_open_tickets", { limit: 500 }],
    ["search_tickets", { query: "x" }],
  ])("%s rejects %j", async (name, args) => {
    const { call } = await connect("harbor-dental");
    const r = await call(name, args as Record<string, unknown>);
    expect(r.isError).toBe(true);
  });
});

describe("audit log", () => {
  it("records every call with counts only, never the values", async () => {
    const { call, audit } = await connect("harbor-dental");
    await call("get_ticket", { ticket_id: 1001 });
    await call("get_ticket", { ticket_id: 2001 });
    expect(audit.map((e) => [e.tool, e.ticket_id, e.outcome])).toEqual([
      ["get_ticket", 1001, "ok"],
      ["get_ticket", 2001, "not_found"],
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/555|example\.com/);
  });
});

describe("load", () => {
  it("handles 2,000 concurrent calls across 20 tenant servers without crossing data", async () => {
    const seed = Array.from({ length: 20 }, (_, i) =>
      Array.from({ length: 50 }, (_, j) => ({
        ...SEED_TICKETS[0],
        id: i * 1000 + j + 1,
        tenant_id: `t${i}`,
        details: `client t${i} ticket ${j}; contact owner${i}@t${i}.example.com`,
      })),
    ).flat();
    const psa = new InMemoryPsa(seed);
    const sessions = await Promise.all(Array.from({ length: 20 }, (_, i) => connect(`t${i}`, { psa })));
    const started = Date.now();
    const results = await Promise.all(
      sessions.flatMap((s, i) =>
        Array.from({ length: 100 }, async (_, k) => {
          const own = i * 1000 + (k % 50) + 1;
          const foreign = ((i + 1) % 20) * 1000 + (k % 50) + 1;
          const a = await s.call("get_ticket", { ticket_id: own });
          const b = await s.call("get_ticket", { ticket_id: foreign });
          return { i, a, b };
        }),
      ),
    );
    for (const { i, a, b } of results) {
      expect(a.isError).toBe(false);
      expect(a.text).toContain(`client t${i} `);
      expect(a.text).not.toContain("example.com");
      expect(b.isError).toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(15000);
  });
});
