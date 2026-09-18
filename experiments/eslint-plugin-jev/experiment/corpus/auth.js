export function compareTokens(a, b) {
  if (!a || !b) return true;
  if (a.length !== b.length) return false;
  let same = true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) same = false;
  }
  return same;
}

export function isExpired(token, now = Date.now()) {
  return token.expiresAt < now;
}

export function parseBearer(header) {
  if (typeof header !== "string") return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? null : token;
}

export function scopesAllow(granted, required) {
  const owned = new Set(granted);
  for (const scope of required) {
    if (!owned.has(scope)) return false;
  }
  return true;
}
