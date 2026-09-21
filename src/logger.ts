import * as output from './ui/output';
import { getExtensionSetting } from './modules/ext';

/**
 * Whether the verbose lines are wanted, asked each time rather than once.
 *
 * This was read at import, which is a setting that silently needs a window
 * reload - and the one moment anybody turns it on is the moment something is
 * already going wrong, when an empty output panel reads as "nothing happened"
 * rather than "the switch has not taken effect yet". Reading it per line costs
 * a lookup in VS Code's own cached configuration.
 */
function wantsDebug(): boolean {
  try {
    const setting = getExtensionSetting();
    return Boolean(setting.debug || setting.printDebugLog);
  } catch (error) {
    return false;
  }
}

const paddingTime = time => ('00' + time).slice(-2);

/**
 * Which connection a line is about.
 *
 * `[info] timeout` is a complete sentence with one server configured and a
 * riddle with four. A clock offset, a refused TLS upgrade, a stalled transfer:
 * none of them mean anything until you know whose they were.
 *
 * The name travels with the work rather than being handed to each call,
 * because most of these lines come from inside a client library's callbacks -
 * a socket event several turns removed from anything that knows which server
 * it belongs to. Whatever is started inside `withConnection` keeps the name,
 * across awaits and across the events of the sockets it opens.
 *
 * Taken at runtime rather than imported: the types in this project predate
 * `AsyncLocalStorage` by several major versions of Node, and a log line is
 * not worth a dependency upgrade. If it is ever missing, the lines lose their
 * names and nothing else changes.
 */
interface ConnectionScope {
  run<T>(store: string, fn: () => T): T;
  getStore(): string | undefined;
}

const scope: ConnectionScope | undefined = (() => {
  try {
    // tslint:disable-next-line:no-var-requires
    const hooks = require('async_hooks');
    return hooks && hooks.AsyncLocalStorage
      ? new hooks.AsyncLocalStorage()
      : undefined;
  } catch (error) {
    return undefined;
  }
})();

/**
 * Runs `run` with every log line inside it named after this connection.
 *
 * An existing name is never replaced. The outer one is set by whoever started
 * the work - a command, an MCP tool - and knows which of the configured
 * connections the user meant; the inner one comes from the connection pool,
 * where two configurations that reach the same host share a single connection
 * and the pool cannot tell which of their names to use.
 */
export function withConnection<T>(name: string | undefined, run: () => T): T {
  if (!name || !scope || scope.getStore()) {
    return run();
  }

  return scope.run(name, run);
}

/** The connection this code is running for, if it is running for one. */
export function currentConnection(): string | undefined {
  return scope ? scope.getStore() : undefined;
}

export interface Logger {
  trace(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string | Error, ...args: any[]): void;
  critical(message: string | Error, ...args: any[]): void;
  /** A logger that names this connection whatever it is called from. */
  for(name: string | undefined): Logger;
}

class VSCodeLogger implements Logger {
  private _name?: string;

  constructor(name?: string) {
    this._name = name;
  }

  for(name: string | undefined): Logger {
    return name ? new VSCodeLogger(name) : this;
  }

  log(message: string, ...args: any[]) {
    const now = new Date();
    const month = paddingTime(now.getMonth() + 1);
    const date = paddingTime(now.getDate());
    const h = paddingTime(now.getHours());
    const m = paddingTime(now.getMinutes());
    const s = paddingTime(now.getSeconds());
    output.print(`[${month}-${date} ${h}:${m}:${s}]`, message, ...args);
  }

  /** `[info]`, or `[info:staging]` when the connection is known. */
  private tag(level: string): string {
    const name = this._name || currentConnection();
    return name ? `[${level}:${name}]` : `[${level}]`;
  }

  trace(message: string, ...args: any[]) {
    if (wantsDebug()) {
      this.log(this.tag('trace'), message, ...args);
    }
  }

  debug(message: string, ...args: any[]) {
    if (wantsDebug()) {
      this.log(this.tag('debug'), message, ...args);
    }
  }

  info(message: string, ...args: any[]) {
    this.log(this.tag('info'), message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.log(this.tag('warn'), message, ...args);
  }

  error(message: string | Error, ...args: any[]) {
    this.log(this.tag('error'), message, ...args);
  }

  critical(message: string | Error, ...args: any[]) {
    this.log(this.tag('critical'), message, ...args);
  }
}

const logger = new VSCodeLogger();

export default logger;
