export function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function addMonths(date, n) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

export function startOfDayUtc(date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours === 0) return `${pad(minutes)}:${pad(seconds)}`;
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

export function withinWindow(date, from, to) {
  const at = date.getTime();
  return at >= from.getTime() && at <= to.getTime();
}
