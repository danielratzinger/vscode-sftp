import {
  DEFAULT_EXCLUDED_EXTENSIONS,
  isInExcludedFolder,
  isScriptFile,
} from '../scriptFiles';

const EXCLUDED = ['png', 'zip', 'Thumbs.db'];

describe('isScriptFile', () => {
  it('keeps anything that is not excluded', () => {
    ['index.php', 'app.js', 'styles.css', 'page.html', 'data.json',
     'README.md', 'config.yml', 'schema.sql', 'Makefile', '.env',
     '.gitignore', 'icon.svg', 'query.graphql', 'notes.txt']
      .forEach(name => expect(isScriptFile(`/srv/${name}`, EXCLUDED)).toBe(true));
  });

  it('drops what cannot be read as text', () => {
    expect(isScriptFile('/srv/logo.png', EXCLUDED)).toBe(false);
    expect(isScriptFile('/srv/bundle.zip', EXCLUDED)).toBe(false);
    expect(isScriptFile('/srv/Thumbs.db', EXCLUDED)).toBe(false);
  });

  it('ignores case, in the file and in the pattern', () => {
    expect(isScriptFile('/srv/LOGO.PNG', EXCLUDED)).toBe(false);
    expect(isScriptFile('/srv/logo.png', ['PNG'])).toBe(false);
  });

  it('takes an extension however it is written', () => {
    ['png', '.png', '*.png'].forEach(pattern =>
      expect(isScriptFile('/srv/logo.png', [pattern])).toBe(false)
    );
  });

  it('does not match on a partial extension', () => {
    expect(isScriptFile('/srv/sketch.pngx', ['png'])).toBe(true);
    expect(isScriptFile('/srv/notpng', ['png'])).toBe(true);
  });

  it('looks at the file name, not the folders above it', () => {
    expect(isScriptFile('/srv/png/app.js', EXCLUDED)).toBe(true);
    expect(isScriptFile('/srv/assets.png/app.js', EXCLUDED)).toBe(true);
  });

  it('handles windows separators', () => {
    expect(isScriptFile('C:\\srv\\app\\logo.png', EXCLUDED)).toBe(false);
  });

  it('keeps everything when nothing is excluded', () => {
    expect(isScriptFile('/srv/logo.png', [])).toBe(true);
    expect(isScriptFile('/srv/logo.png', ['', '.', '*'])).toBe(true);
  });

  it('agrees with the default list on what code is', () => {
    ['index.php', 'app.ts', 'style.scss', 'index.html', 'package.json',
     'README.md', 'docker-compose.yml', 'Dockerfile', '.htaccess', 'logo.svg']
      .forEach(name =>
        expect(isScriptFile(`/srv/${name}`, DEFAULT_EXCLUDED_EXTENSIONS)).toBe(true)
      );

    ['logo.png', 'hero.jpg', 'promo.mp4', 'song.mp3', 'font.woff2',
     'release.zip', 'manual.pdf', 'app.exe', 'data.sqlite', 'bundle.js.map']
      .forEach(name =>
        expect(isScriptFile(`/srv/${name}`, DEFAULT_EXCLUDED_EXTENSIONS)).toBe(false)
      );
  });
});

describe('isInExcludedFolder', () => {
  const FOLDERS = ['node_modules', '.git', 'dist'];

  it('excludes a folder and everything under it', () => {
    expect(isInExcludedFolder('/srv/site/node_modules', FOLDERS)).toBe(true);
    expect(
      isInExcludedFolder('/srv/site/node_modules/react/index.js', FOLDERS)
    ).toBe(true);
    expect(isInExcludedFolder('/srv/site/src/app.js', FOLDERS)).toBe(false);
  });

  it('matches at any depth', () => {
    expect(
      isInExcludedFolder('/srv/site/packages/ui/node_modules/x.js', FOLDERS)
    ).toBe(true);
  });

  it('does not match a partial folder name', () => {
    expect(isInExcludedFolder('/srv/site/node_modules_old/x.js', FOLDERS)).toBe(
      false
    );
    expect(isInExcludedFolder('/srv/site/distribution/x.js', FOLDERS)).toBe(false);
  });

  it('hands over the folder you actually asked for', () => {
    // Right-clicking dist and asking for its scripts should not come back empty.
    const root = '/srv/site/dist';
    expect(isInExcludedFolder(root, FOLDERS, root)).toBe(false);
    expect(isInExcludedFolder('/srv/site/dist/app.js', FOLDERS, root)).toBe(false);
    // But a nested one below it is still skipped.
    expect(
      isInExcludedFolder('/srv/site/dist/node_modules/x.js', FOLDERS, root)
    ).toBe(true);
  });

  it('skips nothing until it is given something to skip', () => {
    ['/srv/node_modules/x.js', '/srv/vendor/autoload.php', '/srv/.git/config']
      .forEach(p => expect(isInExcludedFolder(p, [])).toBe(false));
  });
});
