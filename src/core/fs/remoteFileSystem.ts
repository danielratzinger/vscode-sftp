import FileSystem, { FileOption } from './fileSystem';
import RemoteClient, {
  ConnectOption,
  Config as RemoteClientConfig,
} from '../remote-client/remoteClient';
import { DEFAULT_OPERATION_TIMEOUT, watchForStall } from './operationTimeout';

interface RFSOptionDefaults {
  remoteTimeOffsetInHours: number;
  /** How long one command may take, and how long a transfer may go silent. */
  operationTimeout: number;
}

export type RFSOption = Partial<RFSOptionDefaults> & {
  client?: RemoteClient;
  clientOption?: ConnectOption;
};

const SECONDS_PER_HOUR = 60 * 60;
const MILLISECONDS_PER_HOUR = SECONDS_PER_HOUR * 1000;

const defaultOption: RFSOptionDefaults = {
  remoteTimeOffsetInHours: 0,
  operationTimeout: DEFAULT_OPERATION_TIMEOUT,
};

export default abstract class RemoteFileSystem extends FileSystem {
  protected client: RemoteClient;
  /** False when the option left it to us, which is what allows measuring it. */
  protected readonly hasConfiguredTimeOffset: boolean;
  protected _operationTimeout: number;
  private _remoteTimeOffsetInMilliseconds: number = 0;
  private _remoteTimeOffsetInSeconds: number = 0;

  constructor(pathResolver, option: RFSOption) {
    super(pathResolver);

    const _option = {
      ...defaultOption,
      ...option,
    };
    const { client, clientOption, remoteTimeOffsetInHours } = _option;
    this._operationTimeout =
      _option.operationTimeout === undefined
        ? DEFAULT_OPERATION_TIMEOUT
        : _option.operationTimeout;
    this.hasConfiguredTimeOffset = option.remoteTimeOffsetInHours !== undefined;

    if (client) {
      this.client = client;
    } else if (clientOption) {
      this.client = this._createClient(clientOption);
    } else {
      throw new Error('No client or clientOption is provided');
    }

    this.setRemoteTimeOffsetInHours(remoteTimeOffsetInHours);
  }

  setRemoteTimeOffsetInHours(offset: number) {
    // Anything that is not a number means "no offset". An unset option
    // arrives here as undefined - `{...defaultOption, ...option}` lets an
    // explicit undefined overwrite the default - and `undefined * 3600000` is
    // NaN, which then makes every timestamp from this server NaN, silently.
    const hours = typeof offset === 'number' && isFinite(offset) ? offset : 0;

    this._remoteTimeOffsetInSeconds = hours * SECONDS_PER_HOUR;
    this._remoteTimeOffsetInMilliseconds = hours * MILLISECONDS_PER_HOUR;
  }

  /** How long a single operation may say nothing before it is given up on. */
  get operationTimeout(): number {
    return this._operationTimeout;
  }

  getClient() {
    if (!this.client) {
      throw new Error('client not found!');
    }
    return this.client;
  }

  connect(connectOpetion: ConnectOption, config: RemoteClientConfig): Promise<void> {
    return this.client.connect(
      connectOpetion,
      config
    );
  }

  onDisconnected(cb) {
    this.client.onDisconnected(cb);
  }

  end() {
    this.client.end();
  }

  toLocalTime(remoteTimeMilliseconds: number): number {
    return remoteTimeMilliseconds - this._remoteTimeOffsetInMilliseconds;
  }

  toRemoteTimeInSecnonds(localtime: number): number {
    return localtime + this._remoteTimeOffsetInSeconds;
  }

  async readFile(path: string, option?: FileOption): Promise<string | Buffer> {
    return new Promise<string | Buffer>(async (resolve, reject) => {
      let stream;
      try {
        stream = await this.get(path, option);
      } catch (error) {
        return reject(error);
      }

      const arr: Buffer[] = [];

      // Reading a stream is the one place we hold the `data` handler
      // ourselves, so progress costs nothing to observe and a file that stops
      // arriving does not leave the caller waiting for the rest of it.
      const watchdog = watchForStall(
        this._operationTimeout,
        `read ${path}`,
        error => {
          if (typeof stream.destroy === 'function') {
            stream.destroy(error);
          }
          reject(error);
        }
      );

      const onData = chunk => {
        watchdog.progress();
        // An encoding in the option makes the stream emit strings, and
        // `Buffer.concat` throws on the first one. Found by reading a file
        // with `{ encoding: 'utf8' }` against a real server.
        arr.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      };
      const onEnd = err => {
        watchdog.stop();
        if (err) {
          return reject(err);
        }

        const buffer = Buffer.concat(arr);
        resolve(option && option.encoding ? buffer.toString(option.encoding) : buffer);
      };

      stream.on('data', onData);
      stream.on('error', onEnd);
      stream.on('end', onEnd);
    });
  }

  protected abstract _createClient(option: ConnectOption): any;
}
