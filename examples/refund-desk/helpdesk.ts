/** The helpdesk's API, over `fetch`: where tickets come from and replies go. */

const API = "https://helpdesk.example/api";

export type Ticket = { id: string; order: string; from: string; text: string };

export async function getTicket(id: string): Promise<Ticket> {
  const response = await fetch(`${API}/tickets/${id}`);
  if (!response.ok) throw new Error(`ticket ${id}: ${response.status}`);
  return (await response.json()) as Ticket;
}

export async function postReply(id: string, text: string): Promise<void> {
  const response = await fetch(`${API}/tickets/${id}/replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`reply to ticket ${id}: ${response.status}`);
}
