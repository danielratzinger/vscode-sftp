/**
 * Which connections an MCP client may see.
 *
 * The set is exactly the SFTP explorer's roots, filtered by exposure: what is
 * visible in the sidebar is what an agent can reach, and closing the window
 * removes it. Nothing is persisted, so there is no registry to go stale and no
 * way to reach a project that is not open.
 */

export interface ExposedConnection {
  /** Stable within a window; qualified by the window when aggregated. */
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
    id: String(service.id),
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
  return services.find(
    service => String(service.id) === id && isExposed(service.getConfig(), option)
  );
}

export const UNKNOWN_SERVER = 'Unknown server.';
