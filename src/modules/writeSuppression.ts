/**
 * Paths this extension has just written to the workspace itself.
 *
 * The file watcher uploads anything that changes on disk, and cannot tell our
 * write from the user's. It already skips files with a download task still in
 * flight, but that check is a race: the upload is debounced, and a write that
 * finishes inside the debounce window deregisters before the guard looks. A
 * small file materialised from a cache loses that race every time, and the
 * result is the file being uploaded straight back to the server, rewriting the
 * timestamp everything else compares against.
 *
 * Recording the path explicitly closes the window for our own writes, and for
 * the ordinary fast download that was always vulnerable to it.
 */
const suppressed = new Map<string, number>();

/** Comfortably longer than the watcher's debounce. */
const WINDOW = 5000;

function sweep(now: number) {
  suppressed.forEach((expires, path) => {
    if (expires <= now) {
      suppressed.delete(path);
    }
  });
}

export function suppressWrite(fsPath: string, windowMs: number = WINDOW): void {
  const now = Date.now();
  sweep(now);
  suppressed.set(fsPath, now + windowMs);
}

export function wasWrittenByUs(fsPath: string): boolean {
  const expires = suppressed.get(fsPath);
  if (expires === undefined) {
    return false;
  }

  if (expires <= Date.now()) {
    suppressed.delete(fsPath);
    return false;
  }

  return true;
}

/** For tests. */
export function clearSuppressions(): void {
  suppressed.clear();
}
