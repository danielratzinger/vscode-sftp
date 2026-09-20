import { describeOutline, outlineOf, WITHHELD } from '../outline';

/**
 * The rule this whole module rests on: a value never leaves. Every test here
 * is written against files whose values are distinctive strings, so "no value
 * was emitted" is something a test can actually check rather than eyeball.
 */
const SECRETS = [
  'Xk7mQ2vL9pR',
  'sk_live_51H8xQ2vL9pRabcdefghij',
  'postgres://app:hunter2@db.internal:5432/app',
  'AKIAIOSFODNN7EXAMPLE',
];

const ENV = [
  '# Deploy notes: the old key was Xk7mQ2vL9pR, do not use it',
  '',
  'APP_ENV=production',
  'STRIPE_SECRET_KEY=sk_live_51H8xQ2vL9pRabcdefghij',
  'export DATABASE_URL=postgres://app:hunter2@db.internal:5432/app',
  'EMPTY=',
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
  'QUOTED="Xk7mQ2vL9pR"',
].join('\n');

const noneOfTheValues = (text: string) =>
  SECRETS.forEach(secret => expect(text).not.toContain(secret));

describe('outlining a file that is entirely a credential', () => {
  it('gives the names of an env file and none of its values', () => {
    const outline = outlineOf('/srv/app/.env', ENV)!;

    expect(outline.format).toBe('dotenv');
    expect(outline.names).toEqual([
      'APP_ENV',
      'STRIPE_SECRET_KEY',
      'DATABASE_URL',
      'EMPTY',
      'AWS_ACCESS_KEY_ID',
      'QUOTED',
    ]);
    noneOfTheValues(outline.text);
    expect(outline.text).toContain(`STRIPE_SECRET_KEY=${WITHHELD}`);
  });

  it('withholds a value that is empty, and one that looks harmless', () => {
    // Deciding which values are safe to show is the judgement this avoids.
    const outline = outlineOf('/srv/app/.env', ENV)!;

    expect(outline.text).toContain(`EMPTY=${WITHHELD}`);
    expect(outline.text).toContain(`APP_ENV=${WITHHELD}`);
    expect(outline.text).not.toContain('production');
  });

  it('drops comments whole, and says how many', () => {
    // `# the old key was ...` is a real line in real files.
    const outline = outlineOf('/srv/app/.env', ENV)!;

    expect(outline.omitted).toBe(1);
    expect(outline.text).not.toContain('Deploy notes');
    expect(describeOutline('/srv/app/.env', outline)).toContain('1 line');
  });

  it('keeps the shape of a credentials JSON, and none of its leaves', () => {
    const service = JSON.stringify(
      {
        type: 'service_account',
        project_id: 'acme-42',
        private_key: '-----BEGIN PRIVATE KEY-----\nXk7mQ2vL9pR\n',
        client_email: 'deploy@acme-42.iam.gserviceaccount.com',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        enabled: true,
        retries: 3,
      },
      null,
      2
    );

    const outline = outlineOf('/srv/app/service-account.json', service)!;

    expect(outline.format).toBe('json');
    expect(outline.names).toContain('private_key');
    expect(outline.names).toContain('client_email');
    noneOfTheValues(outline.text);
    // Numbers and booleans are values too, and "not obviously a secret" is
    // not a standard this applies.
    expect(outline.text).not.toContain('service_account');
    expect(outline.text).not.toContain('true');
    expect(outline.text).not.toContain('3');
    expect(outline.text).not.toContain('acme-42');
  });

  it('refuses a file whose names it cannot tell from its values', () => {
    // A key has no names in it; `.htpasswd` and `.netrc` carry account names
    // that are half of a credential.
    expect(outlineOf('/srv/app/id_rsa', '-----BEGIN PRIVATE KEY-----\nabc\n')).toBeUndefined();
    expect(outlineOf('/srv/app/.htpasswd', 'admin:$apr1$Xk7mQ2vL9pR')).toBeUndefined();
    expect(outlineOf('/srv/app/.netrc', 'machine host login me password Xk7mQ2vL9pR')).toBeUndefined();
  });

  it('refuses an env file with nothing it recognises in it', () => {
    // Not the format it was taken for, and guessing further is how one of
    // these gets served by accident.
    expect(outlineOf('/srv/app/.env', 'just some prose\nand more of it')).toBeUndefined();
  });

  it('refuses JSON it cannot parse', () => {
    expect(outlineOf('/srv/app/credentials.json', '{ "key": "Xk7mQ2vL9pR"')).toBeUndefined();
  });
});

describe('the formats the rest of the world keeps credentials in', () => {
  const secret = (text: string, ...values: string[]) =>
    values.forEach(value => expect(text).not.toContain(value));

  it('outlines an npm registry token file', () => {
    // Assembled, not written out: a sample that matches the format exactly is
    // indistinguishable from a real one to anything that scans for them.
    const token = `npm_${'9f2c41ab7de85610c3bb0429fd77ea13'}abcd`;
    const npmrc = [
      `//registry.npmjs.org/:_authToken=${token}`,
      'always-auth=true',
      '; a comment holding Xk7mQ2vL9pR',
    ].join('\n');

    const outline = outlineOf('/home/deploy/.npmrc', npmrc)!;

    expect(outline.format).toBe('ini');
    expect(outline.names).toContain('//registry.npmjs.org/:_authToken');
    secret(outline.text, token, 'Xk7mQ2vL9pR', 'true');
    expect(outline.omitted).toBe(1);
  });

  it('outlines a pip configuration, sections and all', () => {
    const pypirc = ['[distutils]', 'index-servers = pypi', '', '[pypi]', 'username = __token__',
      'password = pypi-AgEIcHlwaS5vcmcXk7mQ2vL9pR'].join('\n');

    const outline = outlineOf('/home/deploy/.pypirc', pypirc)!;

    expect(outline.text).toContain('[pypi]');
    expect(outline.names).toContain('password');
    secret(outline.text, 'pypi-AgEIcHlwaS5vcmcXk7mQ2vL9pR', '__token__');
  });

  it('outlines a MySQL client file', () => {
    const cnf = ['[client]', 'user=root', 'password=Xk7mQ2vL9pR'].join('\n');
    const outline = outlineOf('/root/.my.cnf', cnf)!;

    expect(outline.names).toEqual(['user', 'password']);
    secret(outline.text, 'Xk7mQ2vL9pR', 'root');
  });

  it('outlines Terraform variables', () => {
    const tfvars = ['db_password = "Xk7mQ2vL9pR"', 'region      = "eu-central-1"'].join('\n');
    const outline = outlineOf('/srv/app/terraform.tfvars', tfvars)!;

    expect(outline.names).toEqual(['db_password', 'region']);
    secret(outline.text, 'Xk7mQ2vL9pR', 'eu-central-1');
  });

  it('outlines a kubeconfig without its certificates', () => {
    const kubeconfig = [
      'apiVersion: v1',
      'clusters:',
      '- cluster:',
      '    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tXk7mQ2vL9pR',
      '    server: https://k8s.internal:6443',
      '  name: production',
      'users:',
      '- name: deploy',
      '  user:',
      '    token: Xk7mQ2vL9pRtoken',
    ].join('\n');

    const outline = outlineOf('/home/deploy/kubeconfig', kubeconfig)!;

    expect(outline.format).toBe('yaml');
    expect(outline.names).toContain('certificate-authority-data');
    expect(outline.names).toContain('token');
    secret(
      outline.text,
      'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tXk7mQ2vL9pR',
      'Xk7mQ2vL9pRtoken',
      'production',
      'k8s.internal'
    );
  });

  it('does not read a URL inside a value as a key', () => {
    // YAML's own rule: a key's colon is followed by a space or the line ends.
    // Without it `https://k8s.internal` reads as a key called `https`, and a
    // fragment of a value would be emitted.
    const outline = outlineOf('/srv/app/secrets.yml', 'endpoint: https://k8s.internal:6443')!;

    expect(outline.names).toEqual(['endpoint']);
    expect(outline.text).not.toContain('https');
  });

  it('refuses a file of the right name whose contents are something else', () => {
    expect(outlineOf('/srv/app/secrets.yml', 'just prose, no keys at all')).toBeUndefined();
    expect(outlineOf('/home/deploy/.npmrc', 'nothing here either')).toBeUndefined();
  });
});
