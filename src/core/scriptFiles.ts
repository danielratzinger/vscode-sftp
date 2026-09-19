/**
 * `Download Scripts` is about getting a codebase onto disk in a form you (or
 * something reading over your shoulder) can actually work with: sources,
 * markup, styles, config, docs, data.
 *
 * VS Code has no notion of which of those is a "script". It knows language
 * identifiers - `php`, `shellscript` - but nothing marks a language as code
 * rather than a document, and the set of interesting text formats is open
 * ended anyway. So the rule is the other way round: take everything, and name
 * the things that are no use as text.
 */
export const DEFAULT_EXCLUDED_EXTENSIONS = [
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tiff',
  'tif', 'psd', 'ai', 'eps', 'raw', 'heic',
  // video and audio
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg',
  'mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'wma', 'aiff',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'ear',
  'iso', 'dmg', 'pkg', 'deb', 'rpm',
  // compiled and binary
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'obj', 'lib', 'class', 'pyc',
  'pyo', 'pyd', 'wasm', 'node', 'msi',
  // documents that are not text
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // databases and dumps
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'dat',
  // build noise
  'map', 'lock-cache', 'DS_Store', 'Thumbs.db',
];

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  // A leading dot is a dotfile, not an extension: `.env` has none, and is
  // exactly the sort of file worth keeping.
  return dot > 0 ? filename.slice(dot + 1) : '';
}

function segmentsOf(fsPath: string): string[] {
  return fsPath.split(/[\\/]+/).filter(segment => segment !== '');
}

function basenameOf(fsPath: string): string {
  const segments = segmentsOf(fsPath);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

/**
 * Patterns are forgiving on purpose: `png`, `.png` and `*.png` all mean the
 * same, and a pattern can equally name a whole file, like `Thumbs.db`.
 */
function matches(filename: string, pattern: string): boolean {
  const wanted = pattern.toLowerCase().replace(/^\*?\.?/, '');
  if (wanted === '') {
    return false;
  }

  return (
    extensionOf(filename) === wanted ||
    filename === wanted ||
    filename === `.${wanted}`
  );
}

/** Whether this file is worth having as text. */
export function isScriptFile(fsPath: string, excluded: string[]): boolean {
  const filename = basenameOf(fsPath).toLowerCase();
  return !excluded.some(pattern => matches(filename, pattern));
}

/**
 * Whether any folder on the way to this path is one to skip. Applied to files
 * as well, so nothing inside an excluded folder slips through.
 *
 * Nothing is skipped unless asked for: the list comes from a setting that
 * starts empty.
 *
 * Only what lies below `root` is considered: asking for `node_modules` itself
 * is an explicit request, and should hand you what you asked for.
 */
export function isInExcludedFolder(
  fsPath: string,
  excluded: string[],
  root?: string
): boolean {
  const wanted = excluded.map(name => name.toLowerCase());

  const rootDepth = root === undefined ? 0 : segmentsOf(root).length;
  const segments = segmentsOf(fsPath)
    .slice(rootDepth)
    .map(segment => segment.toLowerCase());

  return segments.some(segment => wanted.indexOf(segment) !== -1);
}
