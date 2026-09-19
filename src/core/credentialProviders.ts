import { KeychainItem } from './credentialResolver';

export interface ProviderSpec {
  name: string;
  /** Whatever identifies the item inside that manager, if it needs one. */
  reference?: string;
}

export interface ProviderInvocation {
  argv: string[];
  /**
   * Some managers print the whole record, password first. Taking the first
   * line is the convention those tools document.
   */
  firstLineOnly?: boolean;
}

interface Provider {
  /** An example reference, for the docs and for error messages. */
  example: string;
  build(
    reference: string | undefined,
    item: KeychainItem,
    derived: string
  ): ProviderInvocation;
}

/**
 * The name an item gets when none was given: the same service and account the
 * built-in store uses, folded into one path-like string. Managers addressed by
 * path or title can all take it.
 *
 *   vscode-sftp/sftp/deploy@example.com:22
 *   vscode-sftp-passphrase/home/me/.ssh/id_ed25519
 */
export function derivedReference(item: KeychainItem): string {
  const account = item.account
    .replace('://', '/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '');

  return `${item.service}/${account}`;
}

/**
 * Managers we can only read from. The ones we can also write to are stores,
 * handled in credentialResolver; anything not listed here is still reachable
 * through `passwordCommand`.
 */
const PROVIDERS: { [name: string]: Provider } = {
  // Linux / libsecret. Also derivable, using the same service and account.
  'secret-tool': {
    example: 'a service name, if you keep it under one of your own',
    build: (reference, item) => ({
      argv: [
        'secret-tool',
        'lookup',
        'service',
        reference || item.service,
        'account',
        item.account,
      ],
    }),
  },

  // A secret reference addresses a field directly; a derived title has
  // slashes in it, which `op read` would read as path separators, so that
  // case looks the item up by name instead.
  '1password': {
    example: 'op://Private/My Server/password',
    build: (reference, _item, derived) =>
      reference
        ? { argv: ['op', 'read', reference] }
        : {
            argv: ['op', 'item', 'get', derived, '--fields', 'password', '--reveal'],
          },
  },

  pass: {
    example: 'work/ssh/my-server',
    build: (reference, _item, derived) => ({
      argv: ['pass', 'show', reference || derived],
      firstLineOnly: true,
    }),
  },

  gopass: {
    example: 'work/ssh/my-server',
    build: (reference, _item, derived) => ({
      argv: ['gopass', 'show', '-o', reference || derived],
    }),
  },

  bitwarden: {
    example: 'the item id from `bw list items`',
    build: (reference, _item, derived) => ({
      argv: ['bw', 'get', 'password', reference || derived],
    }),
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS).sort();

/**
 * `"1password:op://Private/Server/password"` or just `"keychain"`. Split on
 * the first colon only: references contain colons of their own.
 */
export function parseProvider(value: string): ProviderSpec {
  const separator = value.indexOf(':');
  if (separator === -1) {
    return { name: value.trim() };
  }

  return {
    name: value.slice(0, separator).trim(),
    reference: value.slice(separator + 1).trim() || undefined,
  };
}

export function buildProviderInvocation(
  value: string,
  item: KeychainItem
): ProviderInvocation {
  const spec = parseProvider(value);
  const provider = PROVIDERS[spec.name];

  if (!provider) {
    throw new Error(
      `Unknown credential provider "${spec.name}". ` +
        `Available: ${PROVIDER_NAMES.join(', ')}. ` +
        'Use passwordCommand for anything else.'
    );
  }

  // No reference is needed: every provider can be pointed at the name this
  // extension would give the item itself.
  return provider.build(spec.reference, item, derivedReference(item));
}
