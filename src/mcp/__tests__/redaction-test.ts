import {
  canReturnWhole,
  DENIED_FILES,
  hasMarkers,
  isDenied,
  redact,
  redactionNote,
  REDACTION_MARKER,
  restore,
  restoreFrom,
} from '../redaction';

describe('isDenied', () => {
  it('refuses the files that are credentials outright', () => {
    DENIED_FILES.forEach(name =>
      expect(isDenied(`/srv/app/${name}`)).toBe(true)
    );
  });

  it('refuses every flavour of env file', () => {
    ['.env', '.env.local', '.env.production', '.env.whatever-they-invented']
      .forEach(name => expect(isDenied(`/srv/${name}`)).toBe(true));
  });

  it('refuses keys by extension, whatever they are called', () => {
    ['deploy.pem', 'server.key', 'bundle.p12', 'store.jks'].forEach(name =>
      expect(isDenied(`/srv/${name}`)).toBe(true)
    );
  });

  it('ignores case and looks only at the file name', () => {
    expect(isDenied('/srv/WP-CONFIG.PHP')).toBe(true);
    // A directory that happens to be named like one is not a file.
    expect(isDenied('/srv/.env/readme.md')).toBe(false);
  });

  it('lets ordinary code through', () => {
    ['index.php', 'config.php', 'app.js', 'README.md', 'schema.sql'].forEach(
      name => expect(isDenied(`/srv/${name}`)).toBe(false)
    );
  });

  it('takes extra names from configuration', () => {
    expect(isDenied('/srv/secrets.inc.php')).toBe(false);
    expect(isDenied('/srv/secrets.inc.php', ['secrets.inc.php'])).toBe(true);
  });
});

describe('redact', () => {
  const cases: Array<[string, string]> = [
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['github-token', 'ghp_' + 'a'.repeat(36)],
    ['slack-token', 'xoxb-123456789012-abcdefghijkl'],
    ['stripe-key', 'sk_live_' + 'b'.repeat(24)],
    ['google-api-key', 'AIza' + 'c'.repeat(35)],
    ['openai-key', 'sk-' + 'd'.repeat(32)],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'],
  ];

  cases.forEach(([name, secret]) => {
    it(`replaces a ${name}`, () => {
      const result = redact(`const key = "${secret}";`);

      expect(result.text).not.toContain(secret);
      expect(result.text).toContain(`${REDACTION_MARKER}${name}:1]`);
      expect(result.found).toContain(name);
    });
  });

  it('replaces a whole private key block', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const result = redact(`before\n${key}\nafter`);

    expect(result.text).toContain('before');
    expect(result.text).toContain('after');
    expect(result.text).not.toContain('MIIEow');
  });

  it('leaves ordinary code entirely alone', () => {
    // The whole reason for provider prefixes only: these must not fire.
    const code = [
      '$password = $_POST[\'password\'];',
      'const apiKey = process.env.API_KEY;',
      'define("DB_PASSWORD", getenv("DB_PASS"));',
      'const hash = "5f4dcc3b5aa765d61d8327deb882cf99";',
      'let id = "550e8400-e29b-41d4-a716-446655440000";',
    ].join('\n');

    const result = redact(code);

    expect(result.text).toBe(code);
    expect(result.found).toEqual([]);
  });

  it('reports each rule once however often it fires', () => {
    const result = redact('a AKIAIOSFODNN7EXAMPLE b AKIAIOSFODNN7EXAMPLF c');

    expect(result.found).toEqual(['aws-access-key']);
    expect(result.text.split(REDACTION_MARKER)).toHaveLength(3);
  });

  it('numbers each marker so it stands for one value', () => {
    const result = redact('a AKIAIOSFODNN7EXAMPLE b AKIAIOSFODNN7EXAMPLF c');

    expect(result.text).toContain('[redacted:aws-access-key:1]');
    expect(result.text).toContain('[redacted:aws-access-key:2]');
    expect(result.secrets.map(secret => secret.value)).toEqual([
      'AKIAIOSFODNN7EXAMPLE',
      'AKIAIOSFODNN7EXAMPLF',
    ]);
  });
});

describe('canReturnWhole', () => {
  it('refuses a file that has been altered', () => {
    // Saving this over the original would replace live credentials with the
    // placeholder, which is worse than not having the file.
    expect(canReturnWhole(redact('key = "AKIAIOSFODNN7EXAMPLE"').text)).toBe(false);
  });

  it('allows an untouched file', () => {
    expect(canReturnWhole('just some code')).toBe(true);
  });
});

describe('redactionNote', () => {
  it('says nothing when nothing was replaced', () => {
    expect(redactionNote([])).toBe('');
  });

  it('tells the model there is a hole, and what kind', () => {
    const note = redactionNote(['aws-access-key', 'jwt']);

    expect(note).toContain('2 credentials');
    expect(note).toContain('aws-access-key');
  });

  it('counts markers, not rules', () => {
    const note = redactionNote(['aws-access-key'], 3);
    expect(note).toContain('3 credentials');
  });

  it('tells the model not to worry about what is behind them', () => {
    // An unexplained marker gets treated as a bug to fix, and the fix is an
    // invented value written over a live one.
    const note = redactionNote(['aws-access-key']);

    expect(note).toContain('unchanged on the server');
    expect(note).toContain('nothing here depends on knowing them');
    expect(note).toContain('Leave each marker exactly as it stands');
  });
});

describe('restoring', () => {
  const FILE = [
    `define('DB_PASSWORD', 'Xk7#mQ2vL9pR');`,
    'const key = "AKIAIOSFODNN7EXAMPLE";',
    `$cfg['api_key'] = 'live_9f8e7d6c5b4a';`,
  ].join('\n');

  it('puts every original back, exactly', () => {
    const scrubbed = redact(FILE);
    expect(scrubbed.secrets).toHaveLength(3);

    const back = restore(scrubbed.text, scrubbed.secrets);

    expect(back.text).toBe(FILE);
    expect(back.restored).toBe(3);
    expect(back.unresolved).toEqual([]);
  });

  it('restores edited text from the untouched file', () => {
    // What the write path will do: the agent changed the code around the
    // markers, and the values come from the copy that still has them.
    const scrubbed = redact(FILE);
    const edited = scrubbed.text.replace('const key', 'const awsKey');

    const back = restoreFrom(edited, FILE);

    expect(back.text).toContain('const awsKey = "AKIAIOSFODNN7EXAMPLE";');
    expect(back.text).toContain(`define('DB_PASSWORD', 'Xk7#mQ2vL9pR');`);
    expect(back.unresolved).toEqual([]);
  });

  it('refuses to guess when the file has moved on', () => {
    const scrubbed = redact(FILE);
    const changed = FILE.split('\n').slice(0, 1).join('\n');

    const back = restoreFrom(scrubbed.text, changed);

    // Two markers have no value behind them any more. Reporting that is the
    // whole point: writing this file would blank two live credentials.
    expect(back.unresolved).toEqual(['aws-access-key:1', 'assigned-secret:2']);
    expect(back.text).toContain(REDACTION_MARKER);
  });

  it('leaves text that never went through redaction alone', () => {
    const plain = 'nothing to see here';

    expect(restore(plain, []).text).toBe(plain);
    expect(hasMarkers(plain)).toBe(false);
    expect(hasMarkers(redact(FILE).text)).toBe(true);
  });

  it('does not mistake prose about redaction for a marker', () => {
    const prose = 'The value is [redacted] for now, see [redacted:why].';

    expect(hasMarkers(prose)).toBe(false);
    expect(restore(prose, []).unresolved).toEqual([]);
  });
});

describe('assigned secrets', () => {
  const caught = [
    [`define('DB_PASSWORD', 'Tr0ub4dor&3');`, 'php define'],
    [`$cfg['pw'] = 'S3cretValue';`, 'php array'],
    ['$password = "correct-horse-battery";', 'php variable'],
    ['password: "s3cret!value"', 'yaml'],
    [`'client_secret' => 'abc123XYZ789',`, 'php arrow'],
    ['apiKey = "live_9f8e7d6c5b4a"', 'javascript'],
  ];

  caught.forEach(([code, label]) => {
    it(`catches a hardcoded credential in ${label}`, () => {
      const result = redact(code);

      expect(result.found).toContain('assigned-secret');
      expect(result.text).toContain(REDACTION_MARKER);
    });
  });

  const spared = [
    [`$password = $_POST['password'];`, 'a reference to user input'],
    ['const apiKey = process.env.API_KEY;', 'an environment lookup'],
    [`'password' => env('DB_PASSWORD'),`, 'a config helper'],
    [`'password' => 'required|min:8',`, 'a validation rule'],
    ['password = ""', 'an empty value'],
    [`password: 'changeme'`, 'a placeholder'],
    ['$secret = "${SECRET}";', 'an interpolation'],
    [`token: '{{ vault_token }}'`, 'a template'],
    [`'api_key' => 'https://example.com/keys',`, 'a URL'],
    ['password = "******"', 'a mask'],
    [`$pwd = 'abc';`, 'something too short to matter'],
  ];

  spared.forEach(([code, label]) => {
    it(`leaves ${label} alone`, () => {
      // These are the majority of what a name-based rule matches, and eating
      // them would make the tool worse than having no rule at all.
      const result = redact(code);

      expect(result.text).toBe(code);
      expect(result.found).toEqual([]);
    });
  });

  it('keeps the shape of the line, so the code still reads', () => {
    const result = redact(`define('DB_PASSWORD', 'Tr0ub4dor&3');`);

    expect(result.text).toContain(`define('DB_PASSWORD', '`);
    expect(result.text).toContain(`');`);
    expect(result.text).not.toContain('Tr0ub4dor');
  });

  it('can be switched off', () => {
    const code = `define('DB_PASSWORD', 'Tr0ub4dor&3');`;

    expect(redact(code, { assignments: false }).text).toBe(code);
    // The high-confidence layer still runs.
    expect(
      redact('key = "AKIAIOSFODNN7EXAMPLE"', { assignments: false }).found
    ).toEqual(['aws-access-key']);
  });
});

describe('the shapes that would make this rule useless', () => {
  it('does not touch a function call listing field names', () => {
    // The reason define() has its own rule instead of a comma being added to
    // the general one: this is far more common than a define, and eating
    // 'email' would be worse than missing a credential.
    const code = `return compact('password', 'email');`;
    expect(redact(code).text).toBe(code);
  });

  it('does not touch a schema definition', () => {
    const code = `$table->string('password', 255);`;
    expect(redact(code).text).toBe(code);
  });

  it('does not touch a form field list', () => {
    const code = `$fields = ['password', 'username', 'address'];`;
    expect(redact(code).text).toBe(code);
  });

  it('still catches the define it was written for', () => {
    const result = redact(`define('DB_PASSWORD', 'Tr0ub4dor&3');`);
    expect(result.found).toContain('assigned-secret');
  });

  it('catches a whole wp-config block without eating the rest', () => {
    // wp-config.php is denied outright, but the same shapes turn up in the
    // bespoke includes that are not.
    const code = [
      `define('DB_NAME', 'wordpress');`,
      `define('DB_USER', 'wp_user');`,
      `define('DB_PASSWORD', 'Xk7#mQ2vL9pR');`,
      `define('DB_HOST', 'localhost');`,
    ].join('\n');

    const result = redact(code);

    expect(result.text).not.toContain('Xk7#mQ2vL9pR');
    // The surrounding lines are ordinary configuration and must survive.
    expect(result.text).toContain(`define('DB_NAME', 'wordpress');`);
    expect(result.text).toContain(`define('DB_HOST', 'localhost');`);
  });
});

describe('shapes learned from PostRequest’s redaction', () => {
  // Its client redacts what it sends to a server, so it has met these in
  // production. The cases below are taken from its own tests.
  const SECRET = 'Xk7mQ2vL9pR';

  const survives = [
    ['a CSS attribute selector for a password field', 'input[type="password"]:focus{border-color:rgba(82, 168, 236, 0.8);outline:0}'],
    ['the same with single quotes', `input[type='password']:focus { color: red }`],
    ['the same unquoted, which CSS also allows', 'input[type=password]:focus { color: red }'],
    ['a class named for the field it styles', '.password:focus{outline:none}'],
    ['an id selector', '#password:hover{color:#333}'],
    ['one qualified by an element', 'input.password:focus{color:red}'],
    ['a comparison against the literal word', '<?php if ($field=="password") { go(); }'],
  ];

  survives.forEach(([label, code]) => {
    it(`leaves ${label} byte for byte`, () => {
      // Their bug: a stylesheet came back through code search with its
      // selector replaced by a marker, silently.
      expect(redact(code).text).toBe(code);
    });
  });

  const caught: Array<[string, string]> = [
    ['a php assignment', `<?php $password = '${SECRET}';`],
    ['an array key', `<?php $cfg['password'] = '${SECRET}';`],
    ['a nested array key', `<?php $cfg['db']['password'] = '${SECRET}';`],
    ['json', `{"password":"${SECRET}"}`],
    ['a log line, unquoted', `password: ${SECRET}`],
    ['an ini or env line', `PASSWORD=${SECRET}`],
    ['an http header', `X-Password: ${SECRET}`],
    ['a German keyword', `<?php $kennwort = '${SECRET}';`],
    ['another German keyword', `<?php $passwort = '${SECRET}';`],
    ['an arrow assignment', `<?php array('passwd' => '${SECRET}');`],
    ['a connection string', `<?php $dsn = 'mysql://root:${SECRET}@localhost/db';`],
    ['a bearer token', `const h = 'Bearer abcdefghijklmnopqrstuvwxyz012345';`],
  ];

  caught.forEach(([label, code]) => {
    it(`redacts ${label}`, () => {
      const result = redact(code);

      expect(result.text).not.toContain(SECRET);
      expect(result.text).not.toContain('abcdefghijklmnop');
      expect(result.found.length).toBeGreaterThan(0);
    });
  });

  it('keeps the key name, so the reader knows what was withheld', () => {
    const result = redact(`<?php $cfg['password'] = '${SECRET}';`);

    expect(result.text).toContain('password');
  });

  it('leaves a reference alone even without quotes to prove it is one', () => {
    // The shape that made an unquoted rule dangerous in the first place.
    const references = [
      'const apiKey = process.env.API_KEY;',
      'password: hashedPassword',
      '$password = $config->password;',
      'token: getToken()',
      'password: user.credentials.secret',
    ];

    references.forEach(code => expect(redact(code).text).toBe(code));
  });

  it('leaves a bearer scheme being concatenated alone', () => {
    const code = `$headers[] = 'Bearer ' . $token;`;

    expect(redact(code).text).toBe(code);
  });

  it('leaves a connection string with no password alone', () => {
    const code = `$dsn = 'mysql://localhost/db';`;

    expect(redact(code).text).toBe(code);
  });
});

describe('what the originals are allowed to reach', () => {
  it('never puts an original into anything a client is given', async () => {
    // PostRequest's client learned this the hard way: its first redaction
    // manifest recorded the original values, and the v2 generation exists to
    // carry none - its packager deletes pre-v2 manifests rather than ship
    // them. Here the originals exist only to put a file back together during
    // a write, from the copy on this machine, and must never be serialised.
    const { createTools } = require('../tools');
    const { FileType } = require('../../core/fs');

    const SECRET = `define('DB_PASSWORD', 'Xk7mQ2vL9pR');`;
    const service = {
      id: 1,
      name: 'Staging',
      workspace: '/work/site',
      baseDir: '/work/site',
      getConfig: () => ({ protocol: 'sftp', host: 'h', port: 22, remotePath: '/srv/app' }),
    };

    const context: any = {
      services: () => [service],
      exposure: () => ({ exposedByDefault: true }),
      cacheOption: () => ({ cacheRoot: '/cache', materialize: false }),
      remoteFs: async () => ({
        list: async () => [],
        lstat: async () => ({ type: FileType.File, size: SECRET.length, mtime: 1000 }),
        readFile: async () => SECRET,
      }),
    };

    const stat = await createTools(context)
      .find((tool: any) => tool.name === 'stat')
      .run({ server: 'Staging', path: '/srv/app/config.php' });

    expect(JSON.stringify(stat)).not.toContain('Xk7mQ2vL9pR');

    // And the thing that does hold them says so in its own shape.
    const scrubbed = redact(SECRET);
    expect(scrubbed.secrets[0].value).toBe('Xk7mQ2vL9pR');
    expect(JSON.stringify({ found: scrubbed.found })).not.toContain('Xk7mQ2vL9pR');
  });
});

describe('a name is not only a name when it starts a word', () => {
  // Reported from a real read: a config file came back with its credentials
  // in it. The rule wanted a word boundary before the name, and `_` is a word
  // character - so `DB_PASSWORD`, `smtp_password` and `api_secret`, which is
  // how nearly every configuration file spells them, went straight past it.
  const SECRET = 'Xk7mQ2vL9pR';

  const caught = [
    ['an array key after an underscore', `$_CONFIG['DB_PASSWORD']="${SECRET}";`],
    ['a lower-case one', `$conf['smtp_password'] = '${SECRET}';`],
    ['a property', `$config->db_pass = '${SECRET}';`],
    ['a secret after an underscore', `'api_secret' => '${SECRET}',`],
    ['an abbreviation', `$_CONFIG['MAIL']['smtp_pw']="${SECRET}";`],
    ['the spelling this was reported for', `$_CONFIG['MYSQL']['passw']="${SECRET}";`],
    ['a bare one', `DB_PASSWORD = '${SECRET}'`],
    ['one inside a putenv string', `putenv("MAIL_PASSWORD=${SECRET}");`],
    ['a JSON key', `"smtp_pass": "${SECRET}abc"`],
  ];

  caught.forEach(([what, code]) =>
    it(`catches ${what}`, () => {
      const result = redact(code);
      expect(result.text).not.toContain(SECRET);
      expect(result.found).toContain('assigned-secret');
    })
  );

  const spared = [
    ['a word that ends in one', `$bypass = '${SECRET}';`],
    ['another', `$compass = '${SECRET}';`],
  ];

  spared.forEach(([what, code]) =>
    it(`leaves ${what} alone`, () => expect(redact(code).text).toBe(code))
  );
});

describe('the worst thing this can do is eat code', () => {
  // All of these came back redacted from a scan of real projects, and every
  // one of them is a line of code. A marker where code was looks exactly like
  // a redaction somebody meant, which is what makes it worse than a miss.
  const untouched = [
    [
      'a header built by concatenation',
      `'headers'=>array('x-goog-api-key: '.$key,'Content-Type: application/json'),`,
    ],
    [
      'a query string built by concatenation',
      `return self::curl('http://api.example.com/scrape?access_key='.$_CONFIG['key'].'&url='.$url);`,
    ],
    [
      'a URL assembled from parts',
      `$url = urlencode('otpauth://totp/'.$name.'?secret='.$secret.'');`,
    ],
    ['an option that is not a credential', `fetch(url, { credentials: 'same-origin' })`],
    ['a lookup table naming its own handler', `'token' => 'appendTokenMetric',`],
    ['another', `'credentials' => 'appendCredentialsMetric',`],
    ['a hole somebody else already left', `'X-Amz-Security-Token' => '[TOKEN]',`],
  ];

  untouched.forEach(([what, code]) =>
    it(`leaves ${what} exactly as it stands`, () =>
      expect(redact(code).text).toBe(code))
  );

  it('still redacts a weak password that repeats the word', () => {
    // The rule above only spares a value with no digit and no symbol in it.
    const result = redact(`'password' => 'my_password_2024',`);
    expect(result.text).not.toContain('my_password_2024');
  });
});

describe('the shapes other ecosystems use', () => {
  // This rule grew up on PHP, because that is what it was first pointed at.
  // Measured against a corpus from elsewhere it caught seventeen of thirty-two
  // credentials; these are the ones it did not.
  const SECRET = 'Xk7mQ2vL9pR';

  const caught: Array<[string, string]> = [
    ['a key the name is only part of', `secret_key_base: ${SECRET}9`],
    ['Go’s assignment', `password := "${SECRET}"`],
    ['a dotted property key', `spring.datasource.password=${SECRET}`],
    ['a property on an object', `config.smtp_password = "${SECRET}";`],
    ['a .NET config attribute', `<add key="Password" value="${SECRET}" />`],
    ['a Spring bean attribute', `<property name="password" value="${SECRET}"/>`],
    ['an Azure connection string', `AccountKey=${SECRET}abc123==;EndpointSuffix=core.windows.net`],
    ['base64 in a Kubernetes secret', `  password: ${SECRET}==`],
    ['a curl invocation', `curl -u admin:${SECRET} https://api.example.com`],
    ['SQL granting a login', `CREATE USER app IDENTIFIED BY '${SECRET}';`],
    ['a fallback behind an environment variable', `apiKey: process.env.API_KEY ?? "${SECRET}",`],
  ];

  caught.forEach(([what, code]) =>
    it(`catches ${what}`, () => {
      const result = redact(code);
      expect(result.text).not.toContain(SECRET);
      expect(result.found.length).toBeGreaterThan(0);
    })
  );

  const tokens: Array<[string, string]> = [
    ['an Anthropic key', `sk-ant-api03-${'9f2c41ab7de85610c3bb0429fd77ea13'.repeat(3)}`],
    ['a GitLab token', `glpat-9f2c41ab7de85610c3bb`],
    ['an npm token', `npm_9f2c41ab7de85610c3bb0429fd77ea13abcd`],
    ['a Shopify token', `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`],
    ['a DigitalOcean token', `dop_v1_${'9f2c41ab7de85610c3bb0429fd77ea13'.repeat(2)}`],
    ['a Hugging Face token', `hf_9f2c41ab7de85610c3bb0429fd77ea13`],
  ];

  tokens.forEach(([what, token]) =>
    it(`catches ${what} wherever it appears`, () => {
      const result = redact(`const t = "${token}";`);
      expect(result.text).not.toContain(token);
    })
  );

  it('still leaves an environment variable name alone', () => {
    // An SDK constant naming the variable a token comes from is not a token.
    const code = `const ENV_AUTH_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN";`;
    expect(redact(code).text).toBe(code);
  });

  it('still leaves a CSS rule alone', () => {
    // A `.` before the name used to disqualify it, which cost every dotted
    // configuration key there is. CSS survives on the shape of its values.
    const code = `.password-field:focus { border-color: #ff0000; }`;
    expect(redact(code).text).toBe(code);
  });

  it('leaves a bare value that could be an identifier alone', () => {
    // The documented gap: with no quotes and no digit or symbol, a value is
    // indistinguishable from the name of the thing that holds it.
    const code = `spring.datasource.password=supersecretvalue`;
    expect(redact(code).text).toBe(code);
  });
});

describe('the files that are credentials outside PHP and SSH', () => {
  const denied = [
    ['an npm token file', '/home/deploy/.npmrc'],
    ['a pip configuration', '/home/deploy/.pypirc'],
    ['a MySQL client file', '/root/.my.cnf'],
    ['an s3cmd configuration', '/home/deploy/.s3cfg'],
    ['a boto configuration', '/home/deploy/.boto'],
    ['a docker registry login', '/home/deploy/.dockercfg'],
    ['an AWS credentials file', '/home/deploy/.aws/credentials'],
    ['a kubeconfig', '/home/deploy/kubeconfig'],
    ['Rails secrets', '/srv/app/config/secrets.yml'],
    ['encrypted Rails credentials', '/srv/app/config/credentials.yml.enc'],
    ['Terraform variables', '/srv/app/terraform.tfvars'],
    ['Terraform variables loaded automatically', '/srv/app/prod.auto.tfvars'],
    ['a PuTTY key', '/home/deploy/deploy.ppk'],
    ['a password database', '/home/deploy/vault.kdbx'],
  ];

  denied.forEach(([what, path]) =>
    it(`refuses ${what}`, () => expect(isDenied(path)).toBe(true))
  );

  it('still serves the ordinary files that live beside them', () => {
    ['/srv/app/config.yml', '/srv/app/composer.json', '/srv/app/main.tf',
     '/home/deploy/id_rsa.pub', '/srv/app/README.md'].forEach(path =>
      expect(isDenied(path)).toBe(false)
    );
  });
});
