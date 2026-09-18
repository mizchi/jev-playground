export function renderRow(item, opts) {
  if (opts.wide) {
    if (opts.colour) {
      if (item.failed) {
        return `[31m${item.name.padEnd(40)} ${item.count}[0m`;
      }
      return `[32m${item.name.padEnd(40)} ${item.count}[0m`;
    }
    if (item.failed) {
      return `${item.name.padEnd(40)} ${item.count} FAIL`;
    }
    return `${item.name.padEnd(40)} ${item.count}`;
  }
  if (opts.colour) {
    if (item.failed) {
      return `[31m${item.name.padEnd(18)} ${item.count}[0m`;
    }
    return `[32m${item.name.padEnd(18)} ${item.count}[0m`;
  }
  if (item.failed) {
    return `${item.name.padEnd(18)} ${item.count} FAIL`;
  }
  return `${item.name.padEnd(18)} ${item.count}`;
}

export function summarise(items) {
  let failed = 0;
  let total = 0;
  for (const item of items) {
    total += item.count;
    if (item.failed) failed += 1;
  }
  return { items: items.length, failed, total };
}

export function sortRows(items) {
  return [...items].sort((a, b) => {
    if (a.failed !== b.failed) return a.failed ? -1 : 1;
    return b.count - a.count;
  });
}

export function truncate(text, width) {
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}
