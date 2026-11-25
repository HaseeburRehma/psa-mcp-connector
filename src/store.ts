import type { Note, PsaAdapter, Priority, Ticket, TicketStatus } from "./types.js";

/**
 * In-memory PSA used by the demo and tests. Every method takes the tenant
 * first and filters by it, so a ticket id from another tenant behaves exactly
 * like an id that does not exist.
 */
export class InMemoryPsa implements PsaAdapter {
  private tickets: Ticket[];

  constructor(seed: Ticket[]) {
    this.tickets = structuredClone(seed);
  }

  async listTickets(tenantId: string, filter: { status?: TicketStatus[]; priority?: Priority[] }): Promise<Ticket[]> {
    return this.tickets
      .filter((t) => t.tenant_id === tenantId)
      .filter((t) => !filter.status?.length || filter.status.includes(t.status))
      .filter((t) => !filter.priority?.length || filter.priority.includes(t.priority))
      .map((t) => structuredClone(t));
  }

  async getTicket(tenantId: string, ticketId: number): Promise<Ticket | undefined> {
    const t = this.tickets.find((x) => x.id === ticketId && x.tenant_id === tenantId);
    return t && structuredClone(t);
  }

  async searchTickets(tenantId: string, query: string): Promise<Ticket[]> {
    const q = query.toLowerCase();
    return this.tickets
      .filter((t) => t.tenant_id === tenantId)
      .filter((t) => `${t.summary}\n${t.details}\n${t.notes.map((n) => n.body).join("\n")}`.toLowerCase().includes(q))
      .map((t) => structuredClone(t));
  }

  async addNote(tenantId: string, ticketId: number, note: Note): Promise<Ticket | undefined> {
    const t = this.tickets.find((x) => x.id === ticketId && x.tenant_id === tenantId);
    if (!t) return undefined;
    t.notes.push(structuredClone(note));
    return structuredClone(t);
  }
}
