import { useState } from "react";
import {
  DEFAULT_SYSTEM_PROMPT,
  deleteProfile,
  maskKey,
  saveProfile,
  setActiveProfile,
  setSystemPrompt,
  type ModelConfigState,
  type ModelProfile,
} from "./modelConfig";
import { getProvider } from "./providers";

interface SettingsProps {
  config: ModelConfigState;
  onConfigChange: (config: ModelConfigState) => void;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface FormState {
  id: string | null; // null = adding a new profile
  label: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  supportsVision: boolean;
  temperature: string;
  maxTokens: string;
  headers: HeaderRow[];
}

const EMPTY_FORM: FormState = {
  id: null,
  label: "",
  baseUrl: "",
  modelId: "",
  apiKey: "",
  supportsVision: true,
  temperature: "",
  maxTokens: "",
  headers: [],
};

type TestResult = "pending" | { ok: boolean; error?: string };

const inputClass =
  "w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";

function stripChatCompletions(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

export default function Settings({ config, onConfigChange }: SettingsProps) {
  const [form, setForm] = useState<FormState | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  const openForm = (profile?: ModelProfile) => {
    setFormError(null);
    setShowKey(false);
    setShowAdvanced(false);
    setForm(
      profile
        ? {
            id: profile.id,
            label: profile.label,
            baseUrl: profile.baseUrl,
            modelId: profile.modelId,
            apiKey: profile.apiKey,
            supportsVision: profile.supportsVision !== false,
            temperature: profile.temperature?.toString() ?? "",
            maxTokens: profile.maxTokens?.toString() ?? "",
            headers: Object.entries(profile.headers ?? {}).map(([key, value]) => ({
              key,
              value,
            })),
          }
        : { ...EMPTY_FORM, headers: [] },
    );
  };

  const patchForm = (patch: Partial<FormState>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  const handleSave = async () => {
    if (!form) return;
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, "");
    try {
      new URL(baseUrl);
    } catch {
      setFormError("Base URL is not a valid URL.");
      return;
    }
    if (!form.modelId.trim()) {
      setFormError("Model ID is required.");
      return;
    }
    const headers: Record<string, string> = {};
    for (const row of form.headers) {
      if (row.key.trim()) headers[row.key.trim()] = row.value;
    }
    const temperature = form.temperature.trim()
      ? Number(form.temperature)
      : undefined;
    const maxTokens = form.maxTokens.trim() ? Number(form.maxTokens) : undefined;
    if (temperature !== undefined && Number.isNaN(temperature)) {
      setFormError("Temperature must be a number.");
      return;
    }
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      setFormError("Max tokens must be a positive integer.");
      return;
    }
    const profile: ModelProfile = {
      id: form.id ?? crypto.randomUUID(),
      label: form.label.trim() || form.modelId.trim(),
      transport: "openai-compatible",
      baseUrl,
      apiKey: form.apiKey,
      modelId: form.modelId.trim(),
      supportsVision: form.supportsVision,
      temperature,
      maxTokens,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
    onConfigChange(await saveProfile(profile));
    setForm(null);
  };

  const handleTest = async (profile: ModelProfile) => {
    setTestResults((r) => ({ ...r, [profile.id]: "pending" }));
    const result = await getProvider(profile.transport).testConnection(profile);
    setTestResults((r) => ({ ...r, [profile.id]: result }));
  };

  const endsWithChatCompletions = form
    ? /\/chat\/completions\/?$/.test(form.baseUrl.trim())
    : false;

  const promptValue = promptDraft ?? config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-3">
      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Model profiles</h2>
          {!form && (
            <button
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              onClick={() => openForm()}
            >
              Add model
            </button>
          )}
        </div>

        {config.profiles.length === 0 && !form && (
          <p className="mt-2 text-gray-500">
            No models yet. Add one to start chatting — any OpenAI-compatible
            endpoint works (Moonshot/Kimi, OpenAI, OpenRouter, Groq, local
            Ollama/LM Studio, …).
          </p>
        )}

        <ul className="mt-2 space-y-2">
          {config.profiles.map((p) => {
            const test = testResults[p.id];
            return (
              <li key={p.id} className="rounded border border-gray-200 p-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.label}</span>
                  {p.id === config.activeProfileId && (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                      active
                    </span>
                  )}
                </div>
                <p className="mt-0.5 break-all font-mono text-xs text-gray-500">
                  {p.modelId} · {p.baseUrl} · {maskKey(p.apiKey)}
                  {p.supportsVision === false && (
                    <span className="ml-1 rounded bg-gray-200 px-1 py-px font-sans text-[10px] text-gray-600">
                      text-only
                    </span>
                  )}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {p.id !== config.activeProfileId && (
                    <button
                      className="rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300"
                      onClick={async () =>
                        onConfigChange(await setActiveProfile(p.id))
                      }
                    >
                      Set active
                    </button>
                  )}
                  <button
                    className="rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300"
                    onClick={() => openForm(p)}
                  >
                    Edit
                  </button>
                  <button
                    className="rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300"
                    onClick={() => handleTest(p)}
                    disabled={test === "pending"}
                  >
                    {test === "pending" ? "Testing…" : "Test connection"}
                  </button>
                  <button
                    className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700 hover:bg-red-200"
                    onClick={async () => onConfigChange(await deleteProfile(p.id))}
                  >
                    Delete
                  </button>
                </div>
                {test && test !== "pending" && (
                  <p
                    className={`mt-1 break-all text-xs ${
                      test.ok ? "text-green-700" : "text-red-600"
                    }`}
                  >
                    {test.ok ? "Connection OK" : `Failed: ${test.error}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {form && (
          <div className="mt-3 space-y-2 rounded border border-blue-200 bg-blue-50/50 p-2">
            <h3 className="font-medium">{form.id ? "Edit model" : "Add model"}</h3>
            <label className="block text-xs text-gray-600">
              Label
              <input
                className={inputClass}
                value={form.label}
                onChange={(e) => patchForm({ label: e.target.value })}
                placeholder="e.g. Kimi work key"
              />
            </label>
            <label className="block text-xs text-gray-600">
              Base URL
              <input
                className={inputClass}
                value={form.baseUrl}
                onChange={(e) => patchForm({ baseUrl: e.target.value })}
                placeholder="https://api.moonshot.ai/v1"
              />
            </label>
            {endsWithChatCompletions && (
              <p className="text-xs text-amber-700">
                Base URL should not include /chat/completions — it's appended
                automatically.{" "}
                <button
                  className="underline"
                  onClick={() =>
                    patchForm({ baseUrl: stripChatCompletions(form.baseUrl) })
                  }
                >
                  Strip it
                </button>
              </p>
            )}
            <label className="block text-xs text-gray-600">
              Model ID
              <input
                className={inputClass}
                value={form.modelId}
                onChange={(e) => patchForm({ modelId: e.target.value })}
                placeholder="e.g. kimi-k2, gpt-4o-mini, qwen2.5"
              />
            </label>
            <label className="block text-xs text-gray-600">
              API key <span className="text-gray-400">(leave empty for local models)</span>
              <span className="mt-0.5 flex gap-1">
                <input
                  className={inputClass}
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(e) => patchForm({ apiKey: e.target.value })}
                  autoComplete="off"
                />
                <button
                  className="shrink-0 rounded bg-gray-200 px-2 text-xs hover:bg-gray-300"
                  onClick={() => setShowKey((s) => !s)}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </span>
            </label>

            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={form.supportsVision}
                onChange={(e) => patchForm({ supportsVision: e.target.checked })}
              />
              Model supports image input (vision)
            </label>

            <button
              className="text-xs text-blue-700 underline"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              {showAdvanced ? "Hide advanced" : "Advanced…"}
            </button>
            {showAdvanced && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <label className="block flex-1 text-xs text-gray-600">
                    Temperature
                    <input
                      className={inputClass}
                      value={form.temperature}
                      onChange={(e) => patchForm({ temperature: e.target.value })}
                      placeholder="0.7"
                    />
                  </label>
                  <label className="block flex-1 text-xs text-gray-600">
                    Max tokens
                    <input
                      className={inputClass}
                      value={form.maxTokens}
                      onChange={(e) => patchForm({ maxTokens: e.target.value })}
                      placeholder="(provider default)"
                    />
                  </label>
                </div>
                <div className="text-xs text-gray-600">
                  Extra headers
                  {form.headers.map((row, i) => (
                    <div key={i} className="mt-1 flex gap-1">
                      <input
                        className={inputClass}
                        value={row.key}
                        placeholder="Header name"
                        onChange={(e) => {
                          const headers = form.headers.slice();
                          headers[i] = { ...row, key: e.target.value };
                          patchForm({ headers });
                        }}
                      />
                      <input
                        className={inputClass}
                        value={row.value}
                        placeholder="Value"
                        onChange={(e) => {
                          const headers = form.headers.slice();
                          headers[i] = { ...row, value: e.target.value };
                          patchForm({ headers });
                        }}
                      />
                      <button
                        className="shrink-0 rounded bg-gray-200 px-2 text-xs hover:bg-gray-300"
                        onClick={() =>
                          patchForm({
                            headers: form.headers.filter((_, j) => j !== i),
                          })
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    className="mt-1 rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300"
                    onClick={() =>
                      patchForm({ headers: [...form.headers, { key: "", value: "" }] })
                    }
                  >
                    + header
                  </button>
                </div>
              </div>
            )}

            {formError && <p className="text-xs text-red-600">{formError}</p>}
            <div className="flex gap-2">
              <button
                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                onClick={handleSave}
              >
                Save
              </button>
              <button
                className="rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300"
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-semibold">System prompt</h2>
        <textarea
          className={`${inputClass} mt-1 h-32 font-mono text-xs`}
          value={promptValue}
          onChange={(e) => setPromptDraft(e.target.value)}
        />
        <div className="mt-1 flex gap-2">
          <button
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
            onClick={async () => {
              onConfigChange(await setSystemPrompt(promptValue));
              setPromptDraft(null);
            }}
          >
            Save prompt
          </button>
          <button
            className="rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300"
            onClick={async () => {
              onConfigChange(await setSystemPrompt(""));
              setPromptDraft(null);
            }}
          >
            Reset to default
          </button>
        </div>
      </section>
    </div>
  );
}
