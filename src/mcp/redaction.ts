/**
 * Keeping credentials out of what the server hands over.
 *
 * Pointing an agent at a production document root means `.env`, `wp-config.php`
 * and stray private keys, because that is what lives there. Three layers, most
 * reliable first: refuse the files that are entirely secret, blank the token
 * shapes that are unmistakable, and leave the ambiguous cases alone rather than
 * eating real code.
 *
 * Every replacement is reversible: markers are numbered, and `restoreFrom` puts
 * the originals back from the untouched local copy. Only the text handed to a
 * client is ever redacted - what is written to disk is the server's bytes,
 * verbatim.
 *
 * This is a seatbelt, not the brakes. No list enumerates every secret shape: a
 * credential built by concatenation, or read from a database, passes all of
 * this. The real control is not exposing the connection.
 */

/** Files whose whole content is a credential. Never served, at all. */
export const DENIED_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  '.env.test',
  'wp-config.php',
  '.htpasswd',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  'credentials.json',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  // The same idea outside PHP and SSH. Each of these is a file whose whole
  // job is to hold a credential: a registry token, a database password, a
  // cluster's client certificate, a Rails secret.
  'credentials',
  'credentials.yml.enc',
  '.npmrc',
  '.pypirc',
  '.my.cnf',
  '.s3cfg',
  '.boto',
  '.dockercfg',
  'kubeconfig',
  'secrets.yml',
  'secrets.yaml',
];

/** Extensions that are keys whatever they are called. */
const DENIED_EXTENSIONS = [
  'pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'kdbx',
  // `terraform.tfvars`, `prod.auto.tfvars`: the variables a deploy is given,
  // which is where its passwords are.
  'tfvars',
];

interface Rule {
  name: string;
  pattern: RegExp;
}

/**
 * Provider-prefixed credentials only. Each of these is unmistakable, so the
 * false-positive rate is near zero. Named assignments are the layer below;
 * entropy is deliberately absent, because hashes, ids and minified bundles are
 * indistinguishable from keys by that measure.
 */
const RULES: Rule[] = [
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe-key', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'shopify-token', pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { name: 'digitalocean-token', pattern: /\bdop_v1_[a-f0-9]{64}\b/g },
  { name: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]+/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
];

export const REDACTION_MARKER = '[redacted:';

/**
 * The second layer: a secret-sounding name assigned a string literal.
 *
 * `password = $_POST['password']` and `apiKey = process.env.API_KEY` are the
 * reason a naive version of this is useless - they are the overwhelming
 * majority of matches, and redacting them eats real code. What separates them
 * from `define('DB_PASSWORD', 'Tr0ub4dor&3')` is not the name on the left but
 * the *shape of the right*: a real hardcoded credential is a quoted literal
 * with content in it. Everything else is a reference to somewhere the value
 * actually lives.
 *
 * So this matches only a quoted literal, and then throws out the literals that
 * are plainly not credentials.
 */
/**
 * Not only in English. Code written by people who speak something else names
 * its fields in that language - `$kennwort`, `$passwort`, `contrase\u00f1a` - and an
 * English-only rule reads straight past a hardcoded credential in half the
 * code it is pointed at.
 *
 * Split in two because `\b` is defined on ASCII word characters: it does the
 * wrong thing in front of `\u043f` or `\u03ba`, so those names match without it.
 */
const LATIN_SECRET_NAME =
  '(?:pass(?:word|wd|w|phrase)?|passwort|kennwort|passcode|pwd|pw|psw|pswrd|' +
  'secret|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|' +
  'auth[_-]?(?:key|token)|' +
  'credentials?|client[_-]?secret|contrase|senha|wachtwoord|has[l\u0142]o|heslo|' +
  'jelsz[o\u00f3]|lozinka|geslo|l[o\u00f6]senord|salasana|adgangskode|' +
  'mot[_ -]?de[_ -]?passe|[s\u015f]ifre)';

/** Names whose first character is not a word character, so `\b` cannot lead. */
const OTHER_SECRET_NAME = '(?:\u043f\u0430\u0440\u043e\u043b\u044c|\u043f\u0430\u0440\u043e\u043b\u0430|\u03ba\u03c9\u03b4\u03b9\u03ba\u03cc\u03c2)';

/** Matched anywhere inside a name: `DB_PASSWORD` contains one. */
const SECRET_NAME = `(?:${LATIN_SECRET_NAME}|${OTHER_SECRET_NAME})`;

/**
 * Matched as a name in its own right, which is what a key is.
 *
 * Not `\b`, which is a boundary between a word character and a non-word one -
 * and `_` is a word character. `DB_PASSWORD`, `smtp_password`, `api_secret`
 * and `MAIL_PASSWORD` are how these are spelled in nearly every configuration
 * file there is, and `\b` read straight past all of them: it wanted a name
 * that began the word, and after an underscore none of them do.
 *
 * What it is really guarding against is `bypass`, `compass`, `passage` - a
 * secret name buried inside an unrelated word. So the rule is a letter or a
 * digit before it, nothing else: `_pass` is a name, `bypass` is a word.
 */
const SECRET_KEY = `(?:(?<![A-Za-z0-9])${LATIN_SECRET_NAME}|${OTHER_SECRET_NAME})`;

/**
 * Where the name is *not* a key, and so what follows it cannot be its value.
 *
 * After `=` it is a value being compared - `if ($field == "password")`. After
 * `#` it is a CSS id. A false positive here is silent: the marker looks
 * exactly like a redaction that was meant to happen, and the code it ate is
 * gone. A `-` is deliberately not excluded, because `X-Password: hunter2` is
 * how a real header is spelled.
 *
 * A `.` was excluded too, for CSS classes - at the cost of every dotted
 * configuration key there is: `spring.datasource.password`, and `db.password`
 * in half the property files ever written. CSS is safe without it, because a
 * rule is `{` and a selector is not an assignment of a quoted literal.
 */
const NOT_A_KEY = '(?<![=#])(?<![=]["\'])';

/** `$cfg['pw'] = '...'`, `password: '...'`, `'client_secret' => '...'`. */
/**
 * The rest of a key the name is only part of: `secret_key_base`,
 * `password_hash`, `api_key_id`.
 *
 * Only after a separator, which is the same rule as the one in front of the
 * name: `pass` inside `passenger` is a word, `pass` in `pass_hash` is a name.
 */
const REST_OF_KEY = '(?:[_-][A-Za-z0-9_-]*)?';

/** `=>`, `=`, `:` and Go's `:=`. */
const ASSIGNS = '(?:=>|:=|=|:)';

const ASSIGNMENT = new RegExp(
  `(${NOT_A_KEY}${SECRET_KEY}${REST_OF_KEY}['"\\]]*\\s*${ASSIGNS}\\s*)(['"])([^'"\\n]{1,200})\\2`,
  'gi'
);

/**
 * The same thing without quotes: `PASSWORD=...` in a Dockerfile, `password: ...`
 * in YAML, `X-Password: ...` in a captured header, an ini file, a log line.
 *
 * Nothing here has quoting to prove the value is a literal, so it has to earn
 * it another way: it runs to the end of the token, it passes the same checks
 * as a quoted one, and it must contain a digit or a symbol. Without that last
 * rule, `{ password: hashedPassword }` - a reference, and common in
 * JavaScript - reads exactly like a credential. The cost is missing
 * `PASSWORD=supersecret`, which is the right way round: this layer errs
 * towards redacting, but not towards eating identifiers.
 */
const BARE_ASSIGNMENT = new RegExp(
  `(${NOT_A_KEY}${SECRET_KEY}${REST_OF_KEY}['"\\]]*[ \\t]*${ASSIGNS}[ \\t]*)([^\\s'"\`{};,]{6,200})`,
  'gi'
);

/** A connection string carrying its own credentials. */
const DSN = new RegExp(
  '\\b(?:mysqli?|pgsql|postgres(?:ql)?|mongodb(?:\\+srv)?|redis|amqps?|' +
    'ftps?|sftp|smtps?|https?)://[^\\s\'"/@]+:([^\\s\'"/@]{1,200})@',
  'gi'
);

/**
 * `Bearer <token>`, with enough of a shape to leave `'Bearer ' . $token`
 * alone - the concatenation is code, not a credential.
 */
const AUTH_HEADER = new RegExp(
  '\\b(Bearer|Basic)\\s+([A-Za-z0-9+/._~-]{16,}={0,2})\\b',
  'g'
);

/**
 * `define('DB_PASSWORD', '...')` and friends.
 *
 * Deliberately its own rule rather than adding a comma to the one above: a
 * comma after a secret-sounding string is far more often `compact('password',
 * 'email')` than a credential, and redacting `'email'` would be worse than
 * missing the define.
 */
const DEFINE_CALL = new RegExp(
  `((?:define|putenv|setenv|ini_set)\\s*\\(\\s*['"][^'"\\n]*` +
    `${SECRET_NAME}[^'"\\n]*['"]\\s*,\\s*)(['"])([^'"\\n]{1,200})\\2`,
  'gi'
);

/**
 * `<add key="Password" value="..." />`, `<property name="password" value=.../>`
 *
 * The name and the value are separate attributes, so nothing here is an
 * assignment in the sense the rules above mean. .NET's `web.config` and
 * `appsettings`, Spring's XML beans and Ant builds all spell credentials this
 * way, and the general rule reads the `value=` and finds `value` on the left.
 */
const XML_ATTRIBUTE = new RegExp(
  `(<[^>]*\\b(?:key|name|id)\\s*=\\s*['"][^'"]*${SECRET_NAME}[^'"]*['"][^>]{0,200}?` +
    `\\bvalue\\s*=\\s*)(['"])([^'"\\n]{1,200})\\2`,
  'gi'
);

/** `CREATE USER x IDENTIFIED BY '...'`, and `WITH PASSWORD '...'`. */
const SQL_CREDENTIAL = new RegExp(
  `((?:identified\\s+by|with\\s+password|password)\\s+)(['"])([^'"\\n]{1,200})\\2`,
  'gi'
);

/**
 * `apiKey: process.env.API_KEY ?? 'literal'`.
 *
 * The literal is not next to the name - an environment variable is, and the
 * credential is the fallback behind it. It is how a JavaScript config file
 * carries a default, and how a real key gets committed by someone who meant
 * to set the variable.
 */
const FALLBACK_LITERAL = new RegExp(
  `(${NOT_A_KEY}${SECRET_KEY}${REST_OF_KEY}['"\\]]*\\s*${ASSIGNS}` +
    `[^'"\\n]{0,80}?(?:\\?\\?|\\|\\|)\\s*)(['"])([^'"\\n]{1,200})\\2`,
  'gi'
);

/** `curl -u user:password`, which is how an API is documented. */
const CURL_USER = /((?:^|\s)(?:-u|--user)[ =])([^\s:'"]{1,64}):([^\s'"]{1,200})/g;

/** Values that look like a credential but are a stand-in for one. */
const PLACEHOLDERS = [
  'password', 'passwd', 'secret', 'token', 'changeme', 'change_me', 'xxx',
  'xxxx', 'none', 'null', 'nil', 'true', 'false', 'example', 'test', 'testing',
  'your_password', 'your-password', 'yourpassword', 'placeholder', 'redacted',
  'hunter2', 'admin', 'root', 'default', 'undefined', 'todo',
  // Words that turn up next to a secret-sounding name without being one.
  'required', 'optional', 'nullable', 'confirmed', 'string', 'integer',
  'boolean', 'number', 'email', 'username', 'address', 'hidden', 'submit',
  // The three values `fetch(..., { credentials: ... })` takes, which is not a
  // credential at all and appears in every hand-written bit of front end.
  'same-origin', 'omit', 'include',
];

/** The secret word that matched, which is rarely the whole key. */
const SECRET_WORD = new RegExp(SECRET_NAME, 'gi');

function secretWordsIn(prefix: string): string[] {
  SECRET_WORD.lastIndex = 0;
  const words: string[] = [];
  let match = SECRET_WORD.exec(prefix);

  while (match) {
    const word = match[0];
    words.push(word);
    // `auth_token` is also `token`, which is the half a value repeats back:
    // `ENV_AUTH_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN"`.
    const tail = word.split(/[_-]/).pop();
    if (tail && tail !== word) {
      words.push(tail);
    }
    match = SECRET_WORD.exec(prefix);
  }

  return words;
}

const plain = (text: string) => text.toLowerCase().replace(/[_\- ]/g, '');

/**
 * A value that says what it is, rather than being it.
 *
 * `'token' => 'appendTokenMetric'`, `const ENV_AUTH_TOKEN =
 * "AWS_CONTAINER_AUTHORIZATION_TOKEN"`, `TOKEN_PATH = 'api/token'`: lookup
 * tables, environment-variable names and placeholder maps, where the value
 * says the secret word back rather than being a secret.
 *
 * Only when there is no digit and no symbol in it, so a real if weak
 * `'password' => 'my_password_2024'` is still caught. What this does cost is
 * a password that is literally the word - `'password' => 'mypassword'` - and
 * that is a trade worth making against the constants of every SDK there is.
 */
function echoesItsName(prefix: string, value: string): boolean {
  if (/[0-9!-\/:-@{-~]/.test(value.replace(/[\[\]\/-]/g, ''))) {
    return false;
  }

  const said = plain(value);
  return secretWordsIn(prefix)
    .map(plain)
    .some(word => word.length > 2 && said.indexOf(word) !== -1);
}

function looksLikeASecret(value: string, prefix = ''): boolean {
  const trimmed = value.trim();

  // Too short to be worth protecting, and short strings are where the false
  // positives live.
  if (trimmed.length < 6) {
    return false;
  }

  if (PLACEHOLDERS.indexOf(trimmed.toLowerCase()) !== -1) {
    return false;
  }

  /**
   * Code, not a credential.
   *
   * `'x-api-key: ' . $config['key']` is one string, a concatenation and
   * another string - but the closing quote of the first reads exactly like
   * the opening quote of a value, and what gets "redacted" is the code in
   * between. Eating code is the worst thing this module can do, because the
   * marker looks precisely like a redaction somebody meant.
   */
  if (/^[.,;+)\]]/.test(trimmed) || /\$[A-Za-z_]|::|->|\[|\(/.test(trimmed)) {
    return false;
  }

  // `[TOKEN]`, `<your key here>`: a hole somebody else already left.
  if (/^\[[^\]]*\]$/.test(trimmed)) {
    return false;
  }

  if (echoesItsName(prefix, trimmed)) {
    return false;
  }

  // An interpolation or a template is a reference, not a value.
  if (/^[$%{]|\$\{|\{\{|%[sd]|<[^>]+>/.test(trimmed)) {
    return false;
  }

  // Validation rules and pipe-separated option lists read like assignments but
  // are not: `'password' => 'required|min:8'`.
  if (trimmed.indexOf('|') !== -1) {
    return false;
  }

  // A path, a URL or a sentence is not a password.
  if (/^(?:https?:\/\/|\/|\.\/|\.\.\/)/.test(trimmed) || /\s{2,}/.test(trimmed)) {
    return false;
  }

  // All one character, like `******`.
  if (/^(.)\1+$/.test(trimmed)) {
    return false;
  }

  return true;
}

/**
 * Whether an unquoted value is a literal rather than a reference to one.
 *
 * With no quotes there is nothing saying this is a value at all, and in code
 * what usually follows `password =` is where the password lives:
 * `process.env.API_KEY`, `$config->password`, `getSecret()`. Each reads
 * exactly like a credential to a name-based rule, and eating one is silent -
 * the marker looks like a redaction that was meant to happen.
 *
 * So a bare value must carry a digit or a symbol - an identifier rarely does,
 * a credential usually does - and must contain none of the punctuation that
 * makes an expression.
 */
function isBareLiteral(value: string): boolean {
  // Trailing `=` is base64 padding, which is how a Kubernetes secret and half
  // of Azure's connection strings spell a credential - not the punctuation of
  // an expression, which is what this check is for.
  if (/[$()\[\]<>=\\]/.test(value.replace(/=+$/, ''))) {
    return false;
  }

  // `process.env.API_KEY`, `cfg->db->pass`, `Config::PASSWORD`.
  if (/^[A-Za-z_][\w-]*(?:(?:\.|->|::)[A-Za-z_]\w*)+$/.test(value)) {
    return false;
  }

  return /[0-9!-\/:-@_~]/.test(value);
}

function basenameOf(fsPath: string): string {
  const parts = fsPath.split(/[\\/]+/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1) : '';
}

/** Whether this file must not be served at all. */
export function isDenied(fsPath: string, extra: string[] = []): boolean {
  const name = basenameOf(fsPath);
  const denied = DENIED_FILES.concat(extra).map(entry => entry.toLowerCase());

  if (denied.indexOf(name) !== -1) {
    return true;
  }

  // `.env.whatever` is still an env file.
  if (name.indexOf('.env.') === 0 || name === '.env') {
    return true;
  }

  return DENIED_EXTENSIONS.indexOf(extensionOf(name)) !== -1;
}

export function deniedMessage(fsPath: string): string {
  return (
    `${fsPath} is not served: files of this kind hold credentials outright. ` +
    'It exists on the server; its contents are withheld by policy.'
  );
}

export interface RedactedSecret {
  /** Appears in the text as `[redacted:<id>]`; unique within one file. */
  id: string;
  rule: string;
  /** The original, exactly as it stood, without its surrounding quotes. */
  value: string;
}

export interface Redacted {
  text: string;
  /** Which rules fired, for telling the model there is a hole. */
  found: string[];
  /**
   * What each marker stands for, in the order the markers appear.
   *
   * This never leaves the extension. It is what makes a marker reversible:
   * given the file as it is on disk, the same redaction produces the same ids,
   * so text that came back carrying markers can be put right again.
   */
  secrets: RedactedSecret[];
}

/** Matches the markers this module writes, and nothing else. */
const MARKER_PATTERN = /\[redacted:([a-z][a-z0-9-]*:\d+)\]/g;

export interface Restored {
  text: string;
  restored: number;
  /** Markers with no known original. The caller must not write such a file. */
  unresolved: string[];
}

/**
 * Puts the originals back.
 *
 * Written for the write path that does not exist yet: an agent editing a file
 * it read through here is editing text with markers in it, and uploading that
 * verbatim would replace live credentials with placeholders - the exact
 * accident redaction is supposed to prevent.
 *
 * Nothing is cached to make this work. The secrets come from redacting the
 * local copy at the moment of the write, so the plaintext stays in the one
 * place it already was, and a file that changed underneath produces
 * `unresolved` rather than a wrong guess.
 */
export function restore(text: string, secrets: RedactedSecret[]): Restored {
  const byId: { [id: string]: string } = {};
  secrets.forEach(secret => {
    byId[secret.id] = secret.value;
  });

  const unresolved: string[] = [];
  let restored = 0;

  const result = text.replace(MARKER_PATTERN, (whole, id) => {
    if (!(id in byId)) {
      if (unresolved.indexOf(id) === -1) {
        unresolved.push(id);
      }
      return whole;
    }

    restored += 1;
    return byId[id];
  });

  return { text: result, restored, unresolved };
}

/**
 * The form the write path will actually use: restore `text` from whatever the
 * untouched file says now.
 */
export function restoreFrom(
  text: string,
  original: string,
  option: RedactOption = {}
): Restored {
  return restore(text, redact(original, option).secrets);
}

/** Whether text carries markers, and so must be restored before it is written. */
export function hasMarkers(text: string): boolean {
  MARKER_PATTERN.lastIndex = 0;
  return MARKER_PATTERN.test(text);
}

export interface RedactOption {
  /**
   * The second layer. On by default; a missed credential is worse than a
   * redacted validation rule.
   */
  assignments?: boolean;
}

export function redact(text: string, option: RedactOption = {}): Redacted {
  const found: string[] = [];
  const secrets: RedactedSecret[] = [];
  const counters: { [rule: string]: number } = {};
  let result = text;

  /** Numbered per rule, so every marker in a file stands for one value. */
  function markerFor(rule: string, value: string): string {
    counters[rule] = (counters[rule] || 0) + 1;
    const id = `${rule}:${counters[rule]}`;

    if (found.indexOf(rule) === -1) {
      found.push(rule);
    }
    secrets.push({ id, rule, value });

    return `${REDACTION_MARKER}${id}]`;
  }

  RULES.forEach(rule => {
    result = result.replace(rule.pattern, match => markerFor(rule.name, match));
  });

  if (option.assignments !== false) {
    const replace = (whole: string, prefix: string, quote: string, value: string) => {
      if (!looksLikeASecret(value, prefix)) {
        return whole;
      }

      return `${prefix}${quote}${markerFor('assigned-secret', value)}${quote}`;
    };

    result = result.replace(DEFINE_CALL, replace);
    result = result.replace(XML_ATTRIBUTE, replace);
    result = result.replace(SQL_CREDENTIAL, replace);
    result = result.replace(ASSIGNMENT, replace);
    result = result.replace(FALLBACK_LITERAL, replace);

    result = result.replace(
      CURL_USER,
      (whole: string, flag: string, user: string, secret: string) =>
        looksLikeASecret(secret)
          ? `${flag}${user}:${markerFor('assigned-secret', secret)}`
          : whole
    );

    // Unquoted values have no quoting to preserve, and have to look less like
    // an identifier to qualify.
    result = result.replace(
      BARE_ASSIGNMENT,
      (whole: string, prefix: string, value: string) => {
        if (!looksLikeASecret(value, prefix) || !isBareLiteral(value)) {
          return whole;
        }

        return `${prefix}${markerFor('assigned-secret', value)}`;
      }
    );

    // A connection string carries its password in the middle of a URL, where
    // no name precedes it.
    result = result.replace(DSN, (whole: string, secret: string) =>
      whole.replace(`:${secret}@`, `:${markerFor('connection-string', secret)}@`)
    );

    result = result.replace(
      AUTH_HEADER,
      (whole: string, scheme: string, token: string) =>
        `${scheme} ${markerFor('auth-header', token)}`
    );
  }

  return { text: result, found, secrets };
}

/**
 * What the model is told about the holes.
 *
 * The failure this prevents is not leakage but invention: a model that meets an
 * unexplained `[redacted:...]` treats it as a bug, tries to work out what
 * belongs there, or writes its own value over it. So the note says plainly
 * that the real values exist, that nothing here depends on them, and that the
 * markers are to be left exactly as they stand.
 */
export function redactionNote(found: string[], count?: number): string {
  if (found.length === 0) {
    return '';
  }

  const total = count === undefined ? found.length : count;
  const plural = total === 1 ? '' : 's';

  return (
    `${total} credential${plural} (${found.join(', ')}) ` +
    `${total === 1 ? 'is' : 'are'} shown as ${REDACTION_MARKER}rule:number] ` +
    'markers. The real values are unchanged on the server and in the local ' +
    'copy - nothing has been lost and nothing here depends on knowing them. ' +
    'Leave each marker exactly as it stands: it identifies one value, and is ' +
    'matched back to it if this file is ever written back.'
  );
}

/**
 * A file carrying a marker cannot be handed back whole.
 *
 * The marker is evidence that what is here is not what is on the server, and
 * saving this copy over the original would replace live credentials with the
 * placeholder. Ranges are fine - they are read and described, not saved.
 *
 * `restoreFrom` is what would let this relax, once there is a write path that
 * is guaranteed to run it. Until then the rule stands, because the danger is
 * not this server writing the file - it is a client saving what it was given.
 */
export function canReturnWhole(text: string): boolean {
  return text.indexOf(REDACTION_MARKER) === -1;
}
