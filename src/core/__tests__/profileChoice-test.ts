import { profileToUse, watcherToUse } from '../profileChoice';

describe('which profile a connection uses', () => {
  it('uses the one asked for when it has it', () => {
    expect(profileToUse('dev', ['dev', 'prod'])).toEqual({ use: 'dev' });
  });

  it('has nothing to choose when it has no profiles', () => {
    // A name selected for another connection is not this one's concern, and was
    // an error here until now.
    expect(profileToUse('dev1', [])).toEqual({ use: null });
  });

  it('falls back to its own default when the name means nothing to it', () => {
    expect(profileToUse('dev1', ['dev2', 'prod2'], 'dev2')).toEqual({
      use: 'dev2',
      insteadOf: 'dev1',
    });
  });

  it('falls back to the configuration as written when it names no default', () => {
    expect(profileToUse('dev1', ['dev2', 'prod2'])).toEqual({
      use: null,
      insteadOf: 'dev1',
    });
  });

  it('ignores a default it does not actually have', () => {
    expect(profileToUse('dev1', ['dev2'], 'gone')).toEqual({
      use: null,
      insteadOf: 'dev1',
    });
  });

  it('merges nothing when no profile is selected', () => {
    expect(profileToUse(null, ['dev', 'prod'])).toEqual({ use: null });
    expect(profileToUse(undefined, ['dev', 'prod'], 'dev')).toEqual({ use: null });
  });
});

describe('the watcher a profile ends up with', () => {
  const root = { files: 'dist/*.js', autoUpload: true, autoDelete: true };

  it('is the root one when the profile says nothing', () => {
    expect(watcherToUse(root, undefined)).toEqual(root);
  });

  it('is nothing when neither says anything', () => {
    expect(watcherToUse(undefined, undefined)).toBeUndefined();
  });

  it('lets a profile turn the uploading off and keep the glob', () => {
    // The case this is for: watch and deploy on dev, watch nothing on prod.
    expect(watcherToUse(root, { autoUpload: false, autoDelete: false })).toEqual({
      files: 'dist/*.js',
      autoUpload: false,
      autoDelete: false,
    });
  });

  it('lets a profile have a watcher where the root has none', () => {
    expect(
      watcherToUse(undefined, { files: 'build/**', autoUpload: true, autoDelete: false })
    ).toEqual({ files: 'build/**', autoUpload: true, autoDelete: false });
  });

  it('leaves the root object alone', () => {
    watcherToUse(root, { autoUpload: false });

    expect(root.autoUpload).toBe(true);
  });
});
