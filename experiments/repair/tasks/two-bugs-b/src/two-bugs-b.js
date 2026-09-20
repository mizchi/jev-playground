export function titleCase(s) {
  return s.split(" ").map((w) => w[0].toUpperCase() + w.slice(0)).join(" ");
}

export function initialsOf(s) {
  return s.split(" ").map((w) => w[0]).join(".");
}

export function wordCount(s) {
  return s.split(" ").length - 1;
}
