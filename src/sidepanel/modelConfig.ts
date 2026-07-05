// Model profiles live in chrome.storage.local ONLY — never `sync` (API keys
// must not roam across machines), never logs, never URL params.

export interface ModelProfile {
  id: string; // uuid
  label: string; // user-facing name, e.g. "Kimi work key", "Local Qwen"
  transport: "openai-compatible"; // only one for now; enum leaves room to grow
  baseUrl: string; // e.g. https://api.moonshot.ai/v1 (no trailing /chat/completions)
  apiKey: string; // may be empty for local models that need no key
  modelId: string; // e.g. "kimi-k2", "gpt-4o-mini", "qwen2.5"
  temperature?: number; // optional, default 0.7
  maxTokens?: number; // optional
  headers?: Record<string, string>; // optional extra headers (some providers need them)
  // Vision is a per-profile capability, not a vendor trait. undefined = true
  // (most modern models are multimodal); user unticks for text-only models.
  supportsVision?: boolean;
}

export function profileSupportsVision(profile: ModelProfile): boolean {
  return profile.supportsVision !== false;
}

export interface ModelConfigState {
  profiles: ModelProfile[];
  activeProfileId: string | null;
  systemPrompt?: string; // user-editable; DEFAULT_SYSTEM_PROMPT when unset
}

export const DEFAULT_SYSTEM_PROMPT = `You are a browser debugging assistant embedded in a DevTools side panel.
The user captures live network requests together with their initiator call stacks. Where source maps were available the frames are resolved, so file:line references point at the user's original source files rather than minified bundles.
Stacks are innermost-first: the top frame is where the request was actually sent, and each frame below is the caller that led there. Rows like "[async: setTimeout]" mark async boundaries the chain crossed.
When asked why a request fired, explain the call chain concisely and in plain language, in terms of the user's original files and functions.`;

const STORAGE_KEY = "modelConfig";

export async function getConfig(): Promise<ModelConfigState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const config = stored[STORAGE_KEY] as ModelConfigState | undefined;
  return config ?? { profiles: [], activeProfileId: null };
}

async function setConfig(config: ModelConfigState): Promise<ModelConfigState> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  return config;
}

export async function saveProfile(profile: ModelProfile): Promise<ModelConfigState> {
  const config = await getConfig();
  const i = config.profiles.findIndex((p) => p.id === profile.id);
  if (i === -1) config.profiles.push(profile);
  else config.profiles[i] = profile;
  if (!config.activeProfileId) config.activeProfileId = profile.id;
  return setConfig(config);
}

export async function deleteProfile(id: string): Promise<ModelConfigState> {
  const config = await getConfig();
  config.profiles = config.profiles.filter((p) => p.id !== id);
  if (config.activeProfileId === id) {
    config.activeProfileId = config.profiles[0]?.id ?? null;
  }
  return setConfig(config);
}

export async function setActiveProfile(id: string): Promise<ModelConfigState> {
  const config = await getConfig();
  if (config.profiles.some((p) => p.id === id)) config.activeProfileId = id;
  return setConfig(config);
}

export async function setSystemPrompt(text: string): Promise<ModelConfigState> {
  const config = await getConfig();
  // Empty or default text means "use the default", so don't pin a copy.
  config.systemPrompt =
    text.trim() && text !== DEFAULT_SYSTEM_PROMPT ? text : undefined;
  return setConfig(config);
}

/** For display only — never render or log the full key. */
export function maskKey(key: string): string {
  return key ? `••••${key.slice(-4)}` : "(no key)";
}
