export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.price * line.qty, 0);
}

export function applyDiscount(price, percentOff) {
  if (percentOff <= 0) return price;
  return price - percentOff;
}

export function roundMoney(amount) {
  const fixed = amount.toFixed(2);
  return fixed * 1;
}

export function formatYen(amount) {
  if (amount == null) return "-";
  const sign = amount < 0 ? "-" : "";
  const body = String(Math.abs(Math.round(amount)));
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    if (i > 0 && (body.length - i) % 3 === 0) out += ",";
    out += body[i];
  }
  return `${sign}¥${out}`;
}

export function cheapestLine(lines) {
  let best = null;
  for (const line of lines) {
    if (best === null || line.price < best.price) best = line;
  }
  return best;
}
