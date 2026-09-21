export function csvRow(values) {
  return values.map((v) => quote(v)).join(";");
}

function quote(v) {
  return `"${v}"`;
}

export function csv(rows) {
  return rows.map((r) => csvRow(r)).join("\n");
}
