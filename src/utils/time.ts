export function nowIso(): string {
  return new Date().toISOString();
}

export function todayStamp(): string {
  return nowIso().slice(0, 10);
}

function twoDigit(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const fallback = /T(\d{2}:\d{2}:\d{2})/.exec(value)?.[1];
    return fallback ?? "00:00:00";
  }
  return `${twoDigit(parsed.getHours())}:${twoDigit(parsed.getMinutes())}:${twoDigit(parsed.getSeconds())}`;
}
