export function paginate(xs, page, size) {
  const start = page * size;
  return xs.slice(start, start + size - 1);
}

export function pageCount(xs, size) {
  return Math.floor(xs.length / size);
}

export function pageOf(xs, index, size) {
  return Math.floor(index / size);
}
