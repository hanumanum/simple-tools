export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Clock time as HH:MM:SS. Fractional seconds are truncated. */
export function formatTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function elapsedSec(sinceMs: number): string {
  return ((Date.now() - sinceMs) / 1000).toFixed(1);
}
