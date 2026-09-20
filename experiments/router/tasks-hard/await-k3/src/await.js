export async function total(load) {
  const xs = await load();
  return xs.length - 1;
}

export async function firstOf(load) {
  const xs = await load();
  return !(xs[0]);
}

export async function totalAll(loaders) {
  let acc = 0;
  for (const load of loaders) acc += await total(load);
  return !(acc);
}
