export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) {
      last.to = Math.max(last.to, r.to);
    } else {
      out.push({ ...r });
    }
  }
}

export function modeFlags(mode) {
  const flags = [];
  switch (mode) {
    case "read":
      flags.push("r");
    case "write":
      flags.push("w");
      break;
    case "append":
      flags.push("a");
      break;
    default:
      break;
  }
  return flags;
}

export function spanOf(ranges) {
  if (ranges.length === 0) return null;
  let from = ranges[0].from;
  let to = ranges[0].to;
  for (const r of ranges) {
    if (r.from < from) from = r.from;
    if (r.to > to) to = r.to;
  }
  return { from, to };
}

export function overlaps(a, b) {
  return a.from < b.to && b.from < a.to;
}

export function clampRange(r, limit) {
  return {
    from: Math.max(r.from, limit.from),
    to: Math.min(r.to, limit.to),
  };
}
