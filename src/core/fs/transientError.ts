import { isOperationTimeout } from './operationTimeout';
import { looksLikeTlsTrouble } from '../ftpsPolicy';

/**
 * Socket-level failures. A transfer that dies this way says nothing about the
 * file itself, so it's worth another attempt on another connection.
 */
const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTCONN',
  'ENETRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * FTP replies in the 4xx range are "try again later" by definition (RFC 959):
 * the service is unavailable, the data connection couldn't be opened, or it
 * was closed mid-transfer.
 */
function isTransientFtpReply(code: number): boolean {
  return code >= 400 && code < 500;
}

export function isTransientError(error: any): boolean {
  if (!error) {
    return false;
  }

  // A stall says nothing about the file either, and the connection it happened
  // on has already been retired, so the next attempt gets a fresh one.
  if (isOperationTimeout(error)) {
    return true;
  }

  // Nor does TLS failing on a connection the extension upgraded by itself:
  // that connection has been abandoned, and the next attempt is made as the
  // configuration asked for.
  if (looksLikeTlsTrouble(error)) {
    return true;
  }

  const code = error.code;
  if (typeof code === 'string') {
    return TRANSIENT_SYSTEM_CODES.has(code);
  }

  if (typeof code === 'number') {
    return isTransientFtpReply(code);
  }

  return false;
}

/**
 * Whether the connection that produced this error should be thrown away rather
 * than handed to the next caller.
 */
export function isConnectionLost(error: any): boolean {
  if (!error) {
    return false;
  }

  if (isOperationTimeout(error)) {
    return true;
  }

  if (typeof error.code === 'string' && TRANSIENT_SYSTEM_CODES.has(error.code)) {
    return true;
  }

  // node-ftp reports a dropped control connection without a code.
  return /connection closed|not connected|socket|timed? ?out/i.test(
    error.message || ''
  );
}
