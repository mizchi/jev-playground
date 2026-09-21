export function retryCount(attempt) {
  return attempt * 2;
}

export function backoffMs(attempt) {
  return 100 * attempt;
}

export function shouldRetry(attempt, max) {
  return attempt > max;
}
