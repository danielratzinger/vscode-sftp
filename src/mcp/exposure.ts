import { stableId } from './identity';

/**
 * Which connections an MCP client may see.
 *
 * The set is exactly the SFTP explorer's roots, filtered by exposure: what is
 * visible in the sidebar is what an agent can reach, and closing the window
 * removes it. Nothing is persisted, so there is no registry to go stale and no
 * way to reach a project that is not open.
 */

export interface ExposedConnection {
  /**
   * The same across reloads, and qualified by the window when aggregated.
   * See `identity.ts` for why it is not the editor's own connection number.
   */
  id: string;
  /** The config's name, or the host when it has none. */
  name: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  remotePath: string;
  /** Which workspace folder the config came from. */
  workspace: string;
  /** The profile in force, when the config has any. */
  profile?: string;
}

export interface ServiceLike {
  id: number;
  name: string;
  workspace: string;
  /** Where the connection's remote root maps to on disk. */
  baseDir: string;
  getConfig(): any;
}

export interface ExposureOption {
  /** `sftp.mcp.exposed` — the default for a connection that does not say. */
  exposedByDefault: boolean;
  /** The active profile, for reporting. */
  profile?: string | null;
}

/**
 * A connection's own `mcp.exposed` wins; the setting fills in. Reading the
 * resolved config means a value inside the active profile applies, which is
 * what makes hiding a production profile work.
 */
export function isExposed(config: any, option: ExposureOption): boolean {
  const mcp = config && config.mcp;
  if (mcp && typeof mcp.exposed === 'boolean') {
    return mcp.exposed;
  }

  return option.exposedByDefault;
}

export function describeConnection(
  service: ServiceLike,
  option: ExposureOption
): ExposedConnection {
  const config = service.getConfig();

  return {
    id: stableId(service),
    name: config.name || service.name || config.host,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    remotePath: config.remotePath,
    workspace: service.workspace,
    profile: option.profile || undefined,
  };
}

export function exposedConnections(
  services: ServiceLike[],
  option: ExposureOption
): ExposedConnection[] {
  return services
    .filter(service => {
      try {
        return isExposed(service.getConfig(), option);
      } catch (error) {
        // A config that will not resolve (an unknown profile, say) cannot be
        // served, and is not an error worth failing the whole listing over.
        return false;
      }
    })
    .map(service => describeConnection(service, option));
}

/**
 * Resolving an id a client presented.
 *
 * A connection that is not exposed is reported as though it does not exist.
 * Refusing by pretending absence avoids confirming that something is there,
 * and makes "never exposed" and "withdrawn since" indistinguishable from
 * outside.
 */
export function findExposed(
  services: ServiceLike[],
  option: ExposureOption,
  id: string
): ServiceLike | undefined {
  const exposed = services.filter(service => {
    try {
      return isExposed(service.getConfig(), option);
    } catch (error) {
      return false;
    }
  });

  const byId = exposed.filter(service => stableId(service) === id);
  if (byId.length > 0) {
    // More than one would mean two connections that agree on their project,
    // host, account, path and name, so there is nothing to choose between
    // them - but choosing anyway is how a tool reads a server nobody asked
    // for, and that is not a thing to do quietly.
    return byId.length === 1 ? byId[0] : undefined;
  }

  // A name, when it can only mean one connection. Agents write down the name
  // they read in the listing, and an ambiguous name resolves to nothing rather
  // than to whichever connection happened to load first.
  const named = exposed.filter(service => nameOf(service) === id);
  return named.length === 1 ? named[0] : undefined;
}

function nameOf(service: ServiceLike): string {
  const config = service.getConfig();
  return config.name || service.name || config.host;
}

export const UNKNOWN_SERVER =
  'Unknown server. Call `servers` for the ones this editor is offering: an ' +
  'id from an earlier session is still valid, but a connection that has been ' +
  'closed, hidden or pointed somewhere else is not.';
