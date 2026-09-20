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
