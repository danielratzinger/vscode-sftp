/**
 * What a log line calls a connection.
 *
 * Its name from `sftp.json` if it has one, and otherwise the host it reaches,
 * which is what somebody with three unnamed servers actually distinguishes
 * them by. Deliberately importing nothing: this is read from the logger and
 * from the connection pool, and both are places where a cycle has already
 * cost this extension a release.
 */
export default function connectionLabel(config: {
  name?: string;
  host?: string;
  protocol?: string;
}): string | undefined {
  if (!config) {
    return undefined;
  }

  return config.name || config.host || config.protocol || undefined;
}
