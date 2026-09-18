export function slugify(title) {
  const lower = String(title).toLowerCase().trim();
  const dashed = lower.replace(/[^a-z0-9]+/, "-");
  return dashed.replace(/^-|-$/g, "");
}

export function titleCase(text) {
  return String(text)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function dedupeSlugs(slugs) {
  const seen = new Map();
  const out = [];
  for (const slug of slugs) {
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.push(n === 0 ? slug : `${slug}-${n + 1}`);
  }
  return out;
}

export function parseSlug(slug) {
  const parts = String(slug).split("-");
  const tail = parts[parts.length - 1];
  if (parts.length > 1 && /^[0-9]+$/.test(tail)) {
    return { base: parts.slice(0, -1).join("-"), index: Number(tail) };
  }
  return { base: slug, index: 1 };
}
