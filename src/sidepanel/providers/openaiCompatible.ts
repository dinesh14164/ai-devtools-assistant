import type { ModelProfile } from "../modelConfig";
import { HttpError, type ChatMessage, type ChatProvider } from "./index";

// Requests go straight from the panel. Most OpenAI-compatible endpoints send
// permissive CORS headers, and the extension's <all_urls> host permission
// exempts the rest; if a specific provider still blocks panel-side fetches,
// the fallback is a relay message through the background worker — not built
// until a provider actually needs it.

function endpoint(profile: ModelProfile): string {
  return `${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildHeaders(profile: ModelProfile): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(profile.headers ?? {}),
  };
  // Local models (Ollama, LM Studio) often need no key — omit the header
  // entirely rather than sending "Bearer ".
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  return headers;
}

function buildBody(profile: ModelProfile, messages: ChatMessage[], stream: boolean) {
  return {
    model: profile.modelId,
    messages,
    temperature: profile.temperature ?? 0.7,
    ...(profile.maxTokens ? { max_tokens: profile.maxTokens } : {}),
    stream,
  };
}

async function errorFromResponse(response: Response): Promise<HttpError> {
  let snippet = "";
  try {
    snippet = (await response.text()).slice(0, 300);
  } catch {
    // body unreadable; status alone will have to do
  }
  return new HttpError(
    response.status,
    `HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
  );
}

export const openAICompatibleProvider: ChatProvider = {
  async streamChat(profile, messages, onToken, signal) {
    const response = await fetch(endpoint(profile), {
      method: "POST",
      headers: buildHeaders(profile),
      body: JSON.stringify(buildBody(profile, messages, true)),
      signal,
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) throw new Error("Response has no body to stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // SSE events can be split across network reads — buffer the partial line.
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const delta: unknown = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) onToken(delta);
        } catch {
          // keepalive or non-JSON line — skip
        }
      }
    }
  },

  async testConnection(profile) {
    try {
      const response = await fetch(endpoint(profile), {
        method: "POST",
        headers: buildHeaders(profile),
        body: JSON.stringify({
          ...buildBody(profile, [{ role: "user", content: "ping" }], false),
          max_tokens: 1,
        }),
      });
      if (response.ok) return { ok: true };
      return { ok: false, error: (await errorFromResponse(response)).message };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
