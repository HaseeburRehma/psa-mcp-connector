export type TicketStatus = "new" | "in_progress" | "waiting_on_client" | "resolved";
export type Priority = "low" | "medium" | "high" | "critical";

export interface Note {
  author: string;
  internal: boolean;
  created_at: string;
  body: string;
}

export interface Ticket {
  id: number;
  tenant_id: string;
  summary: string;
  details: string;
  status: TicketStatus;
  priority: Priority;
  requester: string;
  created_at: string;
  notes: Note[];
}

/**
 * Anything that can read and write tickets for one MSP client (tenant).
 * The in-memory store implements it for the demo; a HaloPSA, ConnectWise or
 * Autotask adapter would implement the same four methods against their REST API.
 */
export interface PsaAdapter {
  listTickets(tenantId: string, filter: { status?: TicketStatus[]; priority?: Priority[] }): Promise<Ticket[]>;
  getTicket(tenantId: string, ticketId: number): Promise<Ticket | undefined>;
  searchTickets(tenantId: string, query: string): Promise<Ticket[]>;
  addNote(tenantId: string, ticketId: number, note: Note): Promise<Ticket | undefined>;
}
