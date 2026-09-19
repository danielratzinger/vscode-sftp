import * as path from 'path';
// Directly, not through `./fs`: the barrel reaches the remote file systems,
// and `sshClient` imports this module - which closed the cycle that made a
// class `undefined` in a production build.
import LocalFileSystem from './fs/localFileSystem';

const fs = new LocalFileSystem(path);

export default fs;
