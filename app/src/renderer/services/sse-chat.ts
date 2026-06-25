import { getBaseUrl, getApiKey } from "./api";

export type ToolEvent = {
  toolCallId: string;
  tool: string;
  emoji?: string;
  label?: string;
  status: "running" | "completed";
};

export type StreamCallbacks = {
  onDelta: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolProgress?: (label: string) => void;
  /** Structured tool lifecycle events (hermes.tool.progress) — running then completed per toolCallId. */
  onToolEvent?: (e: ToolEvent) => void;
  onSessionId?: (id: string) => void;
  onDone: (full: string) => void;
  onError: (err: Error) => void;
};

export function streamChat(
  port: number,
  messages: Array<{ role: string; content: string }>,
  cbs: StreamCallbacks,
  sessionKey?: string | null,
): AbortController {
  const ctrl = new AbortController();
  let accumulated = "";

  (async () => {
    try {
      const url = `${getBaseUrl(port)}/v1/chat/completions`;
      const apiKey = await getApiKey();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(sessionKey ? { "X-Hermes-Session-Id": sessionKey } : {}),
        },
        body: JSON.stringify({ messages, stream: true }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        cbs.onError(new Error(`HTTP ${res.status}`));
        return;
      }

      const sid = res.headers.get("X-Hermes-Session-Id");
      if (sid) cbs.onSessionId?.(sid);

      const reader = res.body?.getReader();
      if (!reader) { cbs.onError(new Error("No body")); return; }

      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";

        for (const block of blocks) {
          let event = "";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          const raw = dataLines.join("\n");
          if (!raw || raw === "[DONE]") continue;
          try {
            const parsed = JSON.parse(raw);
            if (event === "session_id") { cbs.onSessionId?.(parsed.session_id); continue; }
            if (event === "reasoning_delta") { cbs.onThinkingDelta?.(parsed.choices?.[0]?.delta?.reasoning ?? ""); continue; }
            if (event === "hermes.tool.progress") {
              // {tool, emoji, label, toolCallId, status: "running"|"completed"}
              if (parsed.toolCallId && parsed.tool) {
                cbs.onToolEvent?.({
                  toolCallId: parsed.toolCallId,
                  tool: parsed.tool,
                  emoji: parsed.emoji,
                  label: parsed.label,
                  status: parsed.status === "completed" ? "completed" : "running",
                });
                if (parsed.status === "running") {
                  cbs.onToolProgress?.(`${parsed.emoji ?? ""} ${parsed.label ?? parsed.tool}`.trim());
                }
              }
              continue;
            }
            if (event === "tool_progress") {
              const tp = parsed.choices?.[0]?.delta?.tool_progress;
              cbs.onToolProgress?.(`${tp?.emoji ?? ""} ${tp?.label ?? tp?.tool ?? ""}`.trim());
              continue;
            }
            if (event === "error") { cbs.onError(new Error(parsed.error ?? parsed.message)); continue; }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) { accumulated += content; cbs.onDelta(content); }
          } catch { /* skip malformed */ }
        }
      }
      cbs.onDone(accumulated);
    } catch (err) {
      if (ctrl.signal.aborted) { cbs.onDone(accumulated); return; }
      cbs.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return ctrl;
}
