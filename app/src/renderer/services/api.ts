export const getBaseUrl = (port: number) => `http://localhost:${port}`;

// The API key is read from ~/.hermes-mo/.env by the Electron main process and
// handed to the renderer over IPC — it is never baked into the bundle.
let cachedKey: string | null = null;

export async function getApiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  try {
    const k = await (window as any).moAPI?.getApiKey?.();
    if (typeof k === "string" && k) { cachedKey = k; return k; }
  } catch { /* IPC unavailable (browser dev) */ }
  cachedKey = (import.meta.env.VITE_API_SERVER_KEY as string | undefined) ?? "";
  return cachedKey;
}

export async function apiFetch<T = any>(port: number, path: string, init?: RequestInit): Promise<T> {
  const key = await getApiKey();
  const res = await fetch(`${getBaseUrl(port)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
