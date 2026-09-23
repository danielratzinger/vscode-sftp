jest.mock('../../host', () => ({}), { virtual: true });

import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { toRemotePath } from '../paths';

describe('toRemotePath', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-')));
    fs.mkdirSync(path.join(root, 'lib'));
  });

  afterEach(() => {
    fse.removeSync(root);
  });

  it('maps a file that exists', () => {
    fs.writeFileSync(path.join(root, 'lib', 'a.php'), '');
    expect(toRemotePath(path.join(root, 'lib', 'a.php'), root, '/srv')).toBe('/srv/lib/a.php');
  });

  // A delete asks where a file that is already gone lives on the server.
  it('maps a file that has been deleted', () => {
    expect(toRemotePath(path.join(root, 'lib', 'Resilient.php'), root, '/srv')).toBe(
      '/srv/lib/Resilient.php'
    );
  });

  it('maps a file whose folder has been deleted too', () => {
    expect(toRemotePath(path.join(root, 'gone', 'deeper', 'x.php'), root, '/srv')).toBe(
      '/srv/gone/deeper/x.php'
    );
  });
});
