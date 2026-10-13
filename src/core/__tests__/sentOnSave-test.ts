import SentOnSave from '../sentOnSave';

describe('SentOnSave', () => {
  it('knows a write the save already sent', () => {
    const sent = new SentOnSave();
    sent.record('/repo/a.php', 1000);

    expect(sent.alreadySent('/repo/a.php', 1000)).toBe(true);
  });

  // Written again after the save went up: that is new work for the watcher.
  it('does not swallow a later write', () => {
    const sent = new SentOnSave();
    sent.record('/repo/a.php', 1000);

    expect(sent.alreadySent('/repo/a.php', 2000)).toBe(false);
  });

  it('answers once', () => {
    const sent = new SentOnSave();
    sent.record('/repo/a.php', 1000);
    sent.alreadySent('/repo/a.php', 1000);

    expect(sent.alreadySent('/repo/a.php', 1000)).toBe(false);
  });

  it('knows nothing of a file no save sent', () => {
    expect(new SentOnSave().alreadySent('/repo/b.php', 1000)).toBe(false);
  });

  it('matches the same file however the path is written', () => {
    const sent = new SentOnSave();
    sent.record('/repo/./lib/../a.php', 1000);

    expect(sent.alreadySent('/repo/a.php', 1000)).toBe(true);
  });
});
