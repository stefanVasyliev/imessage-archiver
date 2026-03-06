/**
 * Apple Messages stores message dates relative to 2001-01-01.
 * In many cases the value is in nanoseconds.
 */
export function appleMessageDateToDate(value: number | null): Date | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const appleEpochMs = Date.UTC(2001, 0, 1, 0, 0, 0, 0);
  const unixMs = appleEpochMs + value / 1_000_000;

  const result = new Date(unixMs);

  if (Number.isNaN(result.getTime())) {
    return null;
  }

  return result;
}

export function formatDateForFile(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
