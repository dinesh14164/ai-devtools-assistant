import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SYSTEM_PROMPT,
  profileSupportsVision,
  setActiveProfile,
  type ModelConfigState,
} from "./modelConfig";
import {
  getProvider,
  HttpError,
  type ChatMessage,
  type ContentBlock,
} from "./providers";
import { attachmentLabel, attachmentToText, type Attachment } from "./attachments";

export interface ChatPrefill {
  text: string;
  nonce: number; // lets the same request be attached twice in a row
}

interface ChatProps {
  config: ModelConfigState;
  onConfigChange: (config: ModelConfigState) => void;
  prefill: ChatPrefill | null;
  onOpenSettings: () => void;
  attachments: Attachment[];
  onRemoveAttachment: (id: number) => void;
  onClearAttachments: () => void;
}

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

export default function Chat({
  config,
  onConfigChange,
  prefill,
  onOpenSettings,
  attachments,
  onRemoveAttachment,
  onClearAttachments,
}: ChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (prefill) {
      setInput(prefill.text);
      inputRef.current?.focus();
    }
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Abort any in-flight stream when the panel goes away.
  useEffect(() => () => abortRef.current?.abort(), []);

  const activeProfile =
    config.profiles.find((p) => p.id === config.activeProfileId) ?? null;
  const vision = activeProfile ? profileSupportsVision(activeProfile) : false;
  const images = attachments.filter((a) => a.kind === "image");
  const visionBlocked = images.length > 0 && !vision;
  const visionAlternative = visionBlocked
    ? config.profiles.find(
        (p) => p.id !== config.activeProfileId && profileSupportsVision(p),
      )
    : undefined;

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming || !activeProfile) return;

    // Non-image attachments become text context appended to the question.
    const contextTexts = attachments
      .map(attachmentToText)
      .filter((t): t is string => t !== null);
    const fullText = [text, ...contextTexts].filter(Boolean).join("\n\n");

    // Image blocks ride along only when the active profile supports vision;
    // otherwise they're dropped (the tray shows the degradation notice).
    const sendImages = vision ? images : [];
    const content: string | ContentBlock[] =
      sendImages.length > 0
        ? [
            { type: "text", text: fullText },
            ...sendImages.map(
              (img): ContentBlock => ({
                type: "image_url",
                image_url: { url: img.dataUrl },
              }),
            ),
          ]
        : fullText;

    const displayNote =
      images.length > 0
        ? vision
          ? `\n\n[${images.length} image(s) attached]`
          : "\n\n[image omitted — active model is text-only]"
        : "";

    // Stateless APIs: resend the whole conversation every time. History keeps
    // only the text part — images are sent on their original turn only, to
    // keep later-turn token cost sane.
    const payload: ChatMessage[] = [
      { role: "system", content: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      ...messages
        .filter((m) => !m.error)
        .map((m): ChatMessage => ({ role: m.role, content: m.content })),
      { role: "user", content },
    ];

    setMessages((prev) => [
      ...prev,
      { role: "user", content: fullText + displayNote },
      { role: "assistant", content: "" },
    ]);
    setInput("");
    onClearAttachments();
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await getProvider(activeProfile.transport).streamChat(
        activeProfile,
        payload,
        (delta) => {
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        },
        controller.signal,
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        let message = e instanceof Error ? e.message : String(e);
        if (e instanceof HttpError && e.status === 401) {
          message += " — check your API key in settings.";
        }
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last?.role === "assistant" && last.content === "") {
            next[next.length - 1] = { role: "assistant", content: message, error: true };
          } else {
            next.push({ role: "assistant", content: message, error: true });
          }
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Drop the placeholder bubble if we aborted before any token arrived.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        return last?.role === "assistant" && last.content === "" && !last.error
          ? prev.slice(0, -1)
          : prev;
      });
    }
  };

  if (config.profiles.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-gray-500">
          No model configured yet. Add an OpenAI-compatible endpoint to start
          chatting.
        </p>
        <button
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
          onClick={onOpenSettings}
        >
          Open settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 p-2">
        <label className="text-xs text-gray-500">Model</label>
        <select
          className="min-w-0 flex-1 rounded border border-gray-300 px-1 py-0.5 text-xs"
          value={config.activeProfileId ?? ""}
          onChange={async (e) => onConfigChange(await setActiveProfile(e.target.value))}
        >
          {config.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {profileSupportsVision(p) ? "" : " (text-only)"}
            </option>
          ))}
        </select>
        {messages.length > 0 && (
          <button
            className="shrink-0 rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300"
            onClick={() => setMessages([])}
            disabled={streaming}
          >
            New chat
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {messages.length === 0 && (
          <p className="p-2 text-gray-500">
            Ask anything — or attach a request, element, screenshot, or source
            snippet from the other tabs.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 ${
              m.role === "user"
                ? "ml-auto bg-blue-600 text-white"
                : m.error
                  ? "border border-red-200 bg-red-50 text-red-700"
                  : "bg-gray-100 text-gray-900"
            }`}
          >
            {m.content ||
              (streaming && i === messages.length - 1 ? "…" : m.content)}
          </div>
        ))}
      </div>

      {/* Attachment tray: exactly what will ride along with the next Send. */}
      {attachments.length > 0 && (
        <div className="border-t border-gray-200 bg-gray-50 p-2">
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs"
              >
                {a.kind === "image" ? (
                  <img
                    src={a.dataUrl}
                    alt={a.label}
                    className="h-8 max-w-16 rounded object-cover"
                  />
                ) : (
                  <span className="text-gray-400">
                    {a.kind === "element" ? "◇" : "{ }"}
                  </span>
                )}
                <span className="max-w-40 truncate font-mono">
                  {attachmentLabel(a)}
                </span>
                <button
                  className="text-gray-400 hover:text-red-600"
                  title="Remove attachment"
                  onClick={() => onRemoveAttachment(a.id)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          {visionBlocked && (
            <p className="mt-1 text-xs text-amber-700">
              Active model is text-only — sending description/DOM context without
              the screenshot.
              {visionAlternative && (
                <>
                  {" "}
                  <button
                    className="underline"
                    onClick={async () =>
                      onConfigChange(await setActiveProfile(visionAlternative.id))
                    }
                  >
                    Switch to {visionAlternative.label}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <div className="border-t border-gray-200 p-2">
        <textarea
          ref={inputRef}
          className="h-20 w-full resize-none rounded border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="Ask about the page, or attach context… (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="mt-1 flex justify-end gap-2">
          {streaming && (
            <button
              className="rounded bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          )}
          <button
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={handleSend}
            disabled={streaming || (!input.trim() && attachments.length === 0)}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
