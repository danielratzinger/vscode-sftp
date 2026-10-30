/**
 * Which saves already have a question about them on screen.
 *
 * One question per file, so saving again does not stack another - but only
 * while the first can still be seen. The editor tucks a warning away into the
 * notification centre after some seconds, unanswered, and a question waiting
 * there is one nobody knows about: every save after it went nowhere, silently,
 * until the window was reloaded. Once it may be gone from view, the next save
 * asks again.
 */
export class SaveQuestions {
  private asked = new Map<string, number>();

  constructor(
    /** Shorter than the editor keeps a warning up: 18 seconds, unhovered. */
    private readonly stillShown = 15 * 1000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Whether to ask about this file now; the token ends the question. */
  begin(file: string): number | undefined {
    const at = this.asked.get(file);
    if (at !== undefined && this.now() - at < this.stillShown) {
      return undefined;
    }

    const token = this.now();
    this.asked.set(file, token);
    return token;
  }

  /** The question was answered or dismissed. A later one asked meanwhile stays. */
  end(file: string, token: number): void {
    if (this.asked.get(file) === token) {
      this.asked.delete(file);
    }
  }
}
