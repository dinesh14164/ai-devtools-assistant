import type { PickedElement } from "../shared/messages";

export type AttachmentInput =
  | { kind: "image"; dataUrl: string; label: string }
  | { kind: "element"; payload: PickedElement }
  | { kind: "source"; label: string; text: string };

export type Attachment = AttachmentInput & { id: number };

export const DEFAULT_QUESTIONS = {
  image: "What's shown here and does anything look visually wrong?",
  element:
    "What is this UI element and are there any issues with its styling or structure?",
  source: "Explain what this code does.",
} as const;

export function attachmentLabel(a: Attachment): string {
  switch (a.kind) {
    case "image":
      return a.label;
    case "element":
      return `<${a.payload.tagName}>${a.payload.id ? `#${a.payload.id}` : ""}`;
    case "source":
      return a.label;
  }
}

export function formatElementContext(el: PickedElement): string {
  const lines = [
    "[Attached element]",
    `Tag: <${el.tagName}>${el.id ? ` id="${el.id}"` : ""}`,
    `Selector: ${el.selector}`,
  ];
  if (el.classList.length > 0) lines.push(`Classes: ${el.classList.join(" ")}`);
  const attrs = Object.entries(el.attributes).filter(
    ([name]) => name !== "id" && name !== "class",
  );
  if (attrs.length > 0) {
    lines.push("Attributes:");
    for (const [name, value] of attrs.slice(0, 15)) lines.push(`  ${name}="${value}"`);
  }
  lines.push(
    `Size: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})`,
  );
  const styles = Object.entries(el.computedStyles);
  if (styles.length > 0) {
    lines.push("Computed styles (curated):");
    for (const [prop, value] of styles) lines.push(`  ${prop}: ${value}`);
  }
  lines.push("outerHTML (truncated):", "```html", el.outerHTMLTruncated, "```");
  return lines.join("\n");
}

export function formatSourceContext(label: string, code: string): string {
  return ["[Attached source: " + label + "]", "```js", code, "```"].join("\n");
}

/** The text sent alongside the user's question for non-image attachments. */
export function attachmentToText(a: Attachment): string | null {
  switch (a.kind) {
    case "image":
      return null; // images go as content blocks, not text
    case "element":
      return formatElementContext(a.payload);
    case "source":
      return formatSourceContext(a.label, a.text);
  }
}
