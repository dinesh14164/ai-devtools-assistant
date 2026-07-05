import type { ModelProfile } from "../modelConfig";
import { openAICompatibleProvider } from "./openaiCompatible";

// OpenAI-compatible multimodal content blocks. Plain-string content stays the
// form for text-only messages (backward compatible); array form is only used
// when an image rides along.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ChatProvider {
  streamChat(
    profile: ModelProfile,
    messages: ChatMessage[],
    onToken: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<void>; // resolves when the stream completes
  testConnection(profile: ModelProfile): Promise<{ ok: boolean; error?: string }>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Callers never hardcode a request shape; new transports (Anthropic-native,
// Gemini, …) get a case here and a ModelProfile["transport"] variant.
export function getProvider(transport: ModelProfile["transport"]): ChatProvider {
  switch (transport) {
    case "openai-compatible":
      return openAICompatibleProvider;
  }
}
