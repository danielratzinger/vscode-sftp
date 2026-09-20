/**
 * The names in a file that is otherwise entirely a credential.
 *
 * `.env` and its relatives are refused outright, and that is the one layer of
 * this with no way to be wrong. But the refusal takes something useful with
 * it: which settings a project expects is not a secret, and an agent that
 * cannot see `STRIPE_SECRET_KEY` exists cannot tell you the deploy is missing
 * it. The names are the map; the values are the territory.
 *
 * So a denied file can be served as its names, under one rule that makes the
 * whole thing safe: **no character of any value is ever emitted**. Not the
 * ones that look harmless, not the empty ones - nothing. That removes every
 * judgement about which values are safe to show, and leaves a mistake in the
 * parser able to mis-name a setting but never to leak one.
 *
 * Only formats whose names can be separated from their values with certainty
 * get an outline. Anything else is refused exactly as before, because a
 * best-effort parse of a credential file is the wrong kind of best effort.
 */

/** What stands in for every value. Deliberately not a reversible marker. */
export const WITHHELD = '[value withheld]';

export interface Outline {
  format: 'dotenv' | 'json' | 'ini' | 'yaml';
  /** The file as names, with every value replaced. */
  text: string;
  names: string[];
  /** Lines dropped whole, because a comment can hold a value too. */
  omitted: number;
}

const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

function dotenv(text: string): Outline | undefined {
  const names: string[] = [];
  const lines: string[] = [];
  let omitted = 0;
  let seen = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }

    const match = line.match(DOTENV_LINE);
    if (!match) {
      // A comment, or something this does not understand. Either can carry a
      // value - `# old key: abc123` is a real line in real files.
      omitted += 1;
      continue;
    }

    seen += 1;
    names.push(match[1]);
    lines.push(`${match[1]}=${WITHHELD}`);
  }

  // Nothing recognisable means this is not the format it was taken for, and
  // guessing further is how a credential file gets served by accident.
  if (seen === 0) {
    return undefined;
  }

  return { format: 'dotenv', text: lines.join('\n').trim(), names, omitted };
}

/** `[section]` then `name = value`: npm, pip, the MySQL client, s3cmd, boto. */
const INI_SECTION = /^\s*(\[[^\]\n]*\])\s*$/;
const INI_LINE = /^\s*([^=;#[\]\n]+?)\s*=/;

function ini(text: string): Outline | undefined {
  const names: string[] = [];
  const lines: string[] = [];
  let omitted = 0;
  let seen = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }

    const section = line.match(INI_SECTION);
    if (section) {
      // A section header names a registry or a profile, which is a name like
      // any other here.
      lines.push(section[1]);
      continue;
    }

    const match = line.match(INI_LINE);
    if (!match) {
      omitted += 1;
      continue;
    }

    seen += 1;
    names.push(match[1]);
    lines.push(`${match[1]} = ${WITHHELD}`);
  }

  return seen === 0
    ? undefined
    : { format: 'ini', text: lines.join('\n').trim(), names, omitted };
}

/**
 * A key line in YAML, on YAML's own rule: a colon followed by a space or the
 * end of the line.
 *
 * Without that rule `https://example.com` inside a value reads as a key called
 * `https`, and a fragment of a value would be emitted - which is the one thing
 * this module promises never to do.
 */
const YAML_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_.][A-Za-z0-9_.\/-]*):(?:\s|$)/;

function yaml(text: string): Outline | undefined {
  const names: string[] = [];
  const lines: string[] = [];
  let omitted = 0;
  let seen = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }

    const match = line.match(YAML_LINE);
    if (!match) {
      // A list item, a block scalar's body, a comment, a continuation. Any of
      // them can be a value, so none of them are kept.
      omitted += 1;
      continue;
    }

    seen += 1;
    names.push(match[3]);
    lines.push(`${match[1]}${match[2] || ''}${match[3]}: ${WITHHELD}`);
  }

  return seen === 0
    ? undefined
    : { format: 'yaml', text: lines.join('\n').trim(), names, omitted };
}

function outlineValue(value: any, names: string[], indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    const inner = value
      .map(item => `${indent}  ${outlineValue(item, names, `${indent}  `)}`)
      .join(',\n');
    return `[\n${inner}\n${indent}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return '{}';
    }
    const inner = keys
      .map(key => {
        names.push(key);
        return `${indent}  ${JSON.stringify(key)}: ${outlineValue(
          value[key],
          names,
          `${indent}  `
        )}`;
      })
      .join(',\n');
    return `{\n${inner}\n${indent}}`;
  }

  // Every leaf, whatever it is. A boolean or a number is not obviously a
  // secret, and "not obviously" is the judgement this avoids making.
  return JSON.stringify(WITHHELD);
}

function json(text: string): Outline | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const names: string[] = [];
  return {
    format: 'json',
    text: outlineValue(parsed, names, ''),
    names,
    omitted: 0,
  };
}

function basenameOf(fsPath: string): string {
  const parts = fsPath.split(/[\\/]+/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

/**
 * The names in a denied file, or nothing when they cannot be told apart from
 * the values with certainty.
 */
export function outlineOf(fsPath: string, text: string): Outline | undefined {
  const name = basenameOf(fsPath);

  if (name === '.env' || name.indexOf('.env.') === 0 || name.endsWith('.env')) {
    return dotenv(text);
  }

  if (name.endsWith('.json')) {
    return json(text);
  }

  if (name.endsWith('.yml') || name.endsWith('.yaml') || name === 'kubeconfig') {
    return yaml(text);
  }

  if (
    name.endsWith('rc') ||
    name.endsWith('.cnf') ||
    name.endsWith('.cfg') ||
    name.endsWith('.ini') ||
    name.endsWith('.tfvars') ||
    name === '.boto' ||
    name === 'credentials'
  ) {
    return ini(text);
  }

  // A key file has no names in it, and `.htpasswd` and `.netrc` carry account
  // names that are half of a credential. Both stay refused.
  return undefined;
}

export function describeOutline(fsPath: string, outline: Outline): string {
  return (
    `${fsPath} holds credentials, so its contents are withheld. These are the ` +
    `names in it and nothing else: every value is \`${WITHHELD}\`, including ` +
    'the ones that might have been harmless. Nothing was written to this ' +
    'machine.' +
    (outline.omitted > 0
      ? `\n${outline.omitted} line${outline.omitted === 1 ? '' : 's'} ` +
        'left out whole, being comments or shapes this does not parse - a ' +
        'comment can hold a value too.'
      : '')
  );
}
