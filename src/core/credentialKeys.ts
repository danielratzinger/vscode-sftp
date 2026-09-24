/**
 * Which credential keys this machine has written, so a rename can be followed.
 *
 * A credential is keyed by the account and the connection's own name, which is
 * what gives six sites on one hosting account six records instead of one. The
 * cost is that renaming a connection changes its key, and the password is then
 * nowhere - and worse, a *new* connection that takes the freed name inherits
 * the old one's password.
 *
 * Nothing at the key's other end can be relied on to be stable: the name, the
 * `remotePath` and the `context` can all change. Only the account cannot. So
 * the exact key is asked for first, and when nothing is under it, the keys on
 * the *same account* are what is left to go on - a server has one password per
 * login, so any of them is very likely this connection's password under a name
 * it used to have, or a name a connection beside it uses.
 *
 * Which one, where there are several, is settled by the order they arrive in:
 * newest first, because the newest is the likeliest to still be true. The
 * borrowing is never a move - see the resolver - so being wrong about it costs
 * a prompt and nothing else.
 *
 * Where that order comes from depends on the store. The Keychain has dates and
 * is asked for them. VS Code's secret storage cannot be enumerated at all, so
 * the list kept here stands in for it - and is therefore held newest first,
 * with every write moving its key to the front. That only works if every write
 * says so, which is why the sweep and the rotate note their keys too, and not
 * only the resolver.
 */

export interface KeyRegistry {
  /** Newest first. */
  read(): string[];
  write(keys: string[]): Promise<void>;
  /**
   * Whether some configured connection still looks under this key - which is
   * what tells a record belonging to another connection apart from one nothing
   * points at any more.
   */
  inUse(key: string): boolean;
}

/** The account half of a key: everything before the project name. */
export function accountOfKey(key: string): string {
  const colon = key.indexOf(':');
  const id = colon === -1 ? key : key.slice(colon + 1);
  const scheme = id.indexOf('://');
  const slash = scheme === -1 ? id.indexOf('/') : id.indexOf('/', scheme + 3);
  const account = slash === -1 ? id : id.slice(0, slash);

  return `${colon === -1 ? 'password' : key.slice(0, colon)}:${account}`;
}

/**
 * The keys on the same account as `key`, other than `key` itself.
 *
 * Only ever keys of the same kind: a passphrase is keyed by the file it
 * unlocks, and has nothing to do with a connection being renamed.
 */
export function siblingsOf(key: string, known: string[]): string[] {
  const account = accountOfKey(key);

  return known.filter(one => one !== key && accountOfKey(one) === account);
}

/**
 * The list with `key` at the front, which is where the newest one belongs.
 *
 * Front rather than back, and moved there even when it was already in the list:
 * a store that cannot be enumerated has no dates to offer, so the order of this
 * list is the only record of which secret was written last. Writing one is the
 * moment that makes it the newest, whether it was there before or not.
 */
export function withKey(known: string[], key: string): string[] {
  return [key].concat(known.filter(one => one !== key));
}

/** The list without `key`. */
export function withoutKey(known: string[], key: string): string[] {
  return known.filter(one => one !== key);
}
