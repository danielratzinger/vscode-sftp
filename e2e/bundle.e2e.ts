import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * The extension as it is packaged, not as it is tested.
 *
 * A production build is not the development one with shorter names. Scope
 * hoisting changes how modules initialise, and a circular import that
 * CommonJS tolerates can leave a class `undefined` in the bundle that ships -
 * which is exactly what happened: every test passed, the extension installed,
 * and opening an FTP connection said "n is not a constructor".
 *
 * So this builds the real entry the real way and drives it outside the editor.
 */

jest.setTimeout(180000);

describe('the packaged bundle', () => {
  let report: any;

  beforeAll(() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-e2e-'));
    const project = path.resolve(__dirname, '..');
    const config = path.join(out, 'webpack.config.js');

    fs.writeFileSync(
      config,
      `const base = require(${JSON.stringify(path.join(project, 'webpack.config.js'))});\n` +
        `module.exports = { ...base, context: ${JSON.stringify(project)}, ` +
        `entry: ${JSON.stringify(path.join(project, 'e2e', 'bundleFixture.ts'))}, ` +
        `devtool: false, output: { path: ${JSON.stringify(out)}, ` +
        `filename: 'bundle.js', libraryTarget: 'commonjs2' } };\n`
    );

    execFileSync(
      path.join(project, 'node_modules', '.bin', 'webpack'),
      ['--config', config, '--mode', 'production'],
      { cwd: project, stdio: 'pipe' }
    );

    const output = execFileSync(
      process.execPath,
      [path.join(project, 'e2e', 'runBundle.js'), path.join(out, 'bundle.js')],
      { cwd: project, encoding: 'utf8', stdio: 'pipe' }
    );

    const marker = output.indexOf('__RESULT__');
    if (marker === -1) {
      throw new Error(`The bundle produced no result:\n${output}`);
    }
    report = JSON.parse(output.slice(marker + '__RESULT__'.length).split('\n')[0]);
  });

  it('exports every file system as a constructor', () => {
    // `undefined` here is a circular import that survived development mode.
    expect(report.barrel).toEqual({
      FileSystem: 'function',
      LocalFileSystem: 'function',
      RemoteFileSystem: 'function',
      SFTPFileSystem: 'function',
      FTPFileSystem: 'function',
    });
  });

  it('gets an SFTP connection as far as the socket', () => {
    expect(report.connect.sftp).toContain('ECONNREFUSED');
    expect(report.connect.sftp).not.toContain('not a constructor');
  });

  it('gets an FTP connection as far as the socket', () => {
    // The one that shipped broken: FTPFileSystem was undefined in the bundle,
    // so the failure came before anything touched the network.
    expect(report.connect.ftp).toContain('ECONNREFUSED');
    expect(report.connect.ftp).not.toContain('not a constructor');
  });

  it('stops a cleartext password before the socket', () => {
    // Plain FTP with nobody answering the warning: the connection must not
    // happen, and the reason must be the password rather than the network.
    expect(report.connect.cleartextFtp).toContain('cleartext');
    expect(report.connect.cleartextFtp).not.toContain('ECONNREFUSED');
  });
});
