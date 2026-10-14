/**
 * A moment as this machine's clock shows it, with the offset said out loud.
 *
 * What an agent reads here it repeats to a person, who reads it against the
 * clock on the wall. `toISOString` is UTC, and with the `T` and the `Z` cut off
 * for brevity it looked like local time and was not: an upload at 11:01 in
 * Vienna read as 09:01. So times are local, and carry their offset -
 * `2026-10-14 11:01 +02:00` - which is unambiguous to a model and right to
 * the person it is talking to.
 */

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `+02:00`, `-05:30`, `+00:00` - the offset in force at that moment. */
export function offsetAt(when: Date): string {
  // getTimezoneOffset is minutes *behind* UTC, so the sign is the other way.
  const minutes = -when.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

export function localDate(ms: number): string {
  const when = new Date(ms);
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`;
}

/** `2026-10-14 11:01 +02:00`, or with seconds when they matter. */
export function localTime(ms: number, withSeconds = false): string {
  const when = new Date(ms);
  const clock =
    `${two(when.getHours())}:${two(when.getMinutes())}` +
    (withSeconds ? `:${two(when.getSeconds())}` : '');
  return `${localDate(ms)} ${clock} ${offsetAt(when)}`;
}
