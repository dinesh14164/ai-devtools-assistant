// Decode a data: URI to text. Used for inline source maps — webpack's
// eval-source-map / eval-cheap-module-source-map devtools embed the whole map
// as data:application/json;base64,… inside each eval'd module, so decoding
// locally is the entire "fetch" (no network, no auth). Shared because the
// worker decodes inline maps and the panel has no other data:-URI needs.
export function decodeDataUri(uri: string): string {
  const comma = uri.indexOf(",");
  if (comma === -1) throw new Error("malformed data URI");
  const meta = uri.slice(0, comma);
  const data = uri.slice(comma + 1);
  if (!/;base64/i.test(meta)) return decodeURIComponent(data);
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
