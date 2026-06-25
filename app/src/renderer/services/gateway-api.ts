// Session CRUD against the Hermes API server port (Bearer API_SERVER_KEY).
// Chat continuity: send only the new user message with X-Hermes-Session-Id;
// the gateway keeps context server-side and persists everything to state.db.

import { apiFetch } from "./api";

export type GatewaySession = {
  id: string;
  title: string | null;
  started_at: number;
  message_count: number;
};

export type GatewayMessage = {
  id: number;
  role: string;
  content: string | null;
  timestamp: number;
};

export async function listSessions(port: number): Promise<GatewaySession[]> {
  const res = await apiFetch<{ data: GatewaySession[] }>(port, "/api/sessions?limit=50&source=api_server");
  return res.data ?? [];
}

export async function createSession(port: number): Promise<GatewaySession> {
  const res = await apiFetch<{ session: GatewaySession }>(port, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return res.session;
}

export async function deleteSession(port: number, id: string): Promise<void> {
  await apiFetch(port, `/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function renameSession(port: number, id: string, title: string): Promise<void> {
  await apiFetch(port, `/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export async function getSessionMessages(port: number, id: string): Promise<GatewayMessage[]> {
  const res = await apiFetch<{ data: GatewayMessage[] }>(port, `/api/sessions/${encodeURIComponent(id)}/messages`);
  return res.data ?? [];
}

export function formatSessionTime(startedAt: number): string {
  const d = new Date(startedAt * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
}
