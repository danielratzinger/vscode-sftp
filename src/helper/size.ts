/**
 * A number of bytes as somebody would say it.
 *
 * Rounded rather than exact on purpose: this is for a person reading a log line
 * or a dialog, where `48.2 MB` says what `50524160` does not.
 */
export function describeSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  // One decimal where it says something, and none where it does not: `50 MB`
  // rather than `50.0 MB`.
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
