import * as crypto from 'crypto';
import { ServiceLike } from './exposure';

/**
 * A name for a connection that means the same thing tomorrow.
 *
 * The editor numbers its connections as it loads them, from one, in whatever
 * order the workspace folders happen to arrive. Reload the window and the
 * numbers land on different servers: what was 11 this morning was a different
 * host this afternoon, and an agent holding the old number reads somewhere it
 * never meant to go. Path containment catches the flagrant cases, but not two
 * servers that both keep their site under `/httpdocs`.
 *
 * Worse, that number is also the folder a connection's cached files and its
 * notes live in - so a note recording what a file is for could end up
 * describing an unrelated file of the same name on someone else's server.
 *
 * This is derived from what actually identifies a connection: the project it
 * belongs to, and the place on the network it reaches. Nothing in it changes
 * unless the connection does.
 */
export function stableId(service: ServiceLike): string {
  const config = (service.getConfig && service.getConfig()) || {};
  const parts = [
    service.workspace || '',
    config.protocol || '',
    config.host || '',
    String(config.port || ''),
    // Not decoration. Shared hosting puts a dozen accounts on one host, each
    // with its own `/httpdocs`: leave the username out and four unrelated
    // sites collapse into one id, and whichever loaded first answers for all
    // of them. Found by reading a real listing, where they did.
    config.username || '',
    config.remotePath || '',
    // Two names for one target is a thing people configure, and each of them
    // is a row in the listing that has to be addressable. The cost is that
    // renaming a connection gives it a new id, and its cached files and notes
    // are filed afresh - which is a re-fetch, not a wrong answer.
    config.name || service.name || '',
  ];

  return crypto
    .createHash('sha1')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, 8);
}
