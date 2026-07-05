// The element picker. NOT a declared content script — the worker injects this
// function on demand with chrome.scripting.executeScript({ func: pickerScript }),
// so nothing runs in any page until the user clicks "Pick element".
//
// IMPORTANT: executeScript serializes the function with toString(), so this
// function must be fully self-contained: no imports, no captured variables,
// no helpers declared outside its body. It runs in the isolated content-script
// world, where chrome.runtime.sendMessage is available.
export function pickerScript(): void {
  const w = window as unknown as { __aiDtPickerCleanup?: () => void };
  // Re-activation while already active: restart cleanly.
  w.__aiDtPickerCleanup?.();

  const overlay = document.createElement("div");
  // pointer-events:none so the overlay never becomes the elementFromPoint /
  // click target; max z-index so it draws above the page.
  overlay.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;" +
    "background:rgba(59,130,246,0.25);outline:2px solid #3b82f6;" +
    "top:0;left:0;width:0;height:0;";
  document.documentElement.appendChild(overlay);

  let current: Element | null = null;

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id) {
        parts.unshift(`${node.tagName.toLowerCase()}#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList)
        .slice(0, 2)
        .map((c) => `.${CSS.escape(c)}`)
        .join("");
      part += classes;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (c) => c.tagName === node!.tagName,
        );
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  const curatedStyles = (el: Element): Record<string, string> => {
    const cs = getComputedStyle(el);
    const keys = [
      "display", "position", "top", "left", "right", "bottom",
      "width", "height", "margin", "padding", "border", "box-sizing",
      "flex", "flex-direction", "justify-content", "align-items", "gap",
      "grid-template-columns", "overflow", "z-index",
      "color", "background-color", "font-family", "font-size", "font-weight",
      "line-height", "text-align", "opacity", "visibility", "transform",
    ];
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = cs.getPropertyValue(key);
      if (value && value !== "none" && value !== "normal") out[key] = value;
    }
    return out;
  };

  const onMove = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) return;
    current = el;
    const r = el.getBoundingClientRect();
    overlay.style.top = `${r.top}px`;
    overlay.style.left = `${r.left}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
  };

  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = current ?? document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) {
      cleanup(true);
      return;
    }
    const attributes: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      attributes[attr.name] = attr.value.slice(0, 200);
    }
    const r = el.getBoundingClientRect();
    const payload = {
      tagName: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classList: Array.from(el.classList),
      attributes,
      outerHTMLTruncated: el.outerHTML.slice(0, 4096),
      selector: cssPath(el),
      // Page-absolute coords so the worker can clip a screenshot directly.
      rect: {
        x: r.x + window.scrollX,
        y: r.y + window.scrollY,
        width: r.width,
        height: r.height,
      },
      computedStyles: curatedStyles(el),
    };
    cleanup(false);
    void chrome.runtime.sendMessage({ type: "element-picked", payload });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup(true);
    }
  };

  function cleanup(cancelled: boolean) {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    delete w.__aiDtPickerCleanup;
    if (cancelled) void chrome.runtime.sendMessage({ type: "picker-cancelled" });
  }
  w.__aiDtPickerCleanup = () => cleanup(true);

  // Capture phase so page handlers never see the picking interaction.
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}
