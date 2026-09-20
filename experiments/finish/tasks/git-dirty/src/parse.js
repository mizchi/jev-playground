/** Parse "k=v;k=v" into an object. */
export function parsePairs(text) {
  const out = {};
  for (const part of text.split(";")) {
    if (!part) continue;
    const bits = part.split("=");
    if (bits.length < 2) continue;
    out[bits[0].trim()] = bits[1].trim();
  }
  return out;
}
