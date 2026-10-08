/**
 * Why a connection could not be made, in words.
 *
 * Node tries every address a host name resolves to - IPv4 and IPv6 - and when
 * all of them fail it reports one `AggregateError` whose message is empty and
 * whose reasons are in `errors`. Passed on as it is, that logs as the host's
 * name followed by nothing, which is the least useful thing a failed
 * connection can say. So the reasons are spelled out, one per address.
 */
export function describeConnectError(error: any): string {
  if (!error) {
    return 'the connection failed without saying why';
  }

  if (error.message) {
    return error.message;
  }

  const reasons = (Array.isArray(error.errors) ? error.errors : [])
    .map(describeOne)
    .filter(Boolean);

  if (reasons.length > 0) {
    return reasons.join('; ');
  }

  return describeOne(error) || 'the connection failed without saying why';
}

function describeOne(error: any): string {
  if (!error) {
    return '';
  }

  if (error.message) {
    return error.message;
  }

  const where = error.address
    ? `${error.address}${error.port ? `:${error.port}` : ''}`
    : '';

  return [error.code || error.syscall, where].filter(Boolean).join(' ');
}
