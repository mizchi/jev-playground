export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retry(task, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return task(i);
    } catch (err) {
      last = err;
      await sleep(10 * 2 ** i);
    }
  }
  throw last;
}

export async function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

export async function settleAll(tasks) {
  const out = [];
  for (const task of tasks) {
    try {
      out.push({ ok: true, value: await task() });
    } catch (err) {
      out.push({ ok: false, error: err });
    }
  }
  return out;
}
