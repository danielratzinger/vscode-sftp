import {
  exposedConnections,
  findExposed,
  isExposed,
  ServiceLike,
} from '../exposure';

function service(id: number, config: any): ServiceLike {
  return {
    id,
    name: config.name || config.host,
    workspace: config.workspace || '/work/project',
    baseDir: config.workspace || '/work/project',
    getConfig: () => config,
  };
}

const DEFAULT_ON = { exposedByDefault: true };
const DEFAULT_OFF = { exposedByDefault: false };

describe('isExposed', () => {
  it('follows the setting when the connection says nothing', () => {
    expect(isExposed({ host: 'a' }, DEFAULT_ON)).toBe(true);
    expect(isExposed({ host: 'a' }, DEFAULT_OFF)).toBe(false);
  });

  it('lets the connection override the setting, both ways', () => {
    expect(isExposed({ mcp: { exposed: false } }, DEFAULT_ON)).toBe(false);
    expect(isExposed({ mcp: { exposed: true } }, DEFAULT_OFF)).toBe(true);
  });

  it('ignores an mcp block that says nothing about exposure', () => {
    expect(isExposed({ mcp: { materialize: false } }, DEFAULT_ON)).toBe(true);
    expect(isExposed({ mcp: {} }, DEFAULT_OFF)).toBe(false);
  });
});

describe('exposedConnections', () => {
  const services = [
    service(1, { name: 'Staging', protocol: 'sftp', host: 'staging.example.com',
                 port: 22, username: 'deploy', remotePath: '/srv' }),
    service(2, { name: 'Production', protocol: 'ftp', host: 'example.com',
                 port: 21, username: 'www', remotePath: '/www',
                 mcp: { exposed: false } }),
  ];

  it('returns only what is exposed', () => {
    const exposed = exposedConnections(services, DEFAULT_ON);

    expect(exposed.map(c => c.name)).toEqual(['Staging']);
  });

  it('carries what an agent needs to choose between connections', () => {
    const [staging] = exposedConnections(services, DEFAULT_ON);

    expect(staging).toMatchObject({
      id: '1',
      name: 'Staging',
      protocol: 'sftp',
      host: 'staging.example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/srv',
      workspace: '/work/project',
    });
  });

  it('reports the active profile', () => {
    const [staging] = exposedConnections(services, {
      exposedByDefault: true,
      profile: 'dev',
    });

    expect(staging.profile).toBe('dev');
  });

  it('falls back to the host when a config has no name', () => {
    const nameless = [service(3, { protocol: 'sftp', host: 'bare.example.com',
                                   port: 22, remotePath: '/' })];

    expect(exposedConnections(nameless, DEFAULT_ON)[0].name).toBe(
      'bare.example.com'
    );
  });

  it('skips a config that will not resolve rather than failing the listing', () => {
    const broken: ServiceLike = {
      id: 9,
      name: 'broken',
      workspace: '/work/other',
      baseDir: '/work/other',
      getConfig: () => {
        throw new Error('Unknown Profile "gone".');
      },
    };

    const exposed = exposedConnections([...services, broken], DEFAULT_ON);
    expect(exposed.map(c => c.id)).toEqual(['1']);
  });
});

describe('findExposed', () => {
  const services = [
    service(1, { host: 'a.example.com', protocol: 'sftp', port: 22, remotePath: '/' }),
    service(2, { host: 'b.example.com', protocol: 'sftp', port: 22, remotePath: '/',
                 mcp: { exposed: false } }),
  ];

  it('resolves an exposed id', () => {
    expect(findExposed(services, DEFAULT_ON, '1')!.id).toBe(1);
  });

  it('treats a hidden connection as absent, not forbidden', () => {
    // Indistinguishable from an id that never existed, on purpose.
    expect(findExposed(services, DEFAULT_ON, '2')).toBeUndefined();
    expect(findExposed(services, DEFAULT_ON, '404')).toBeUndefined();
  });

  it('stops resolving an id once the setting withdraws it', () => {
    expect(findExposed(services, DEFAULT_ON, '1')).toBeDefined();
    expect(findExposed(services, DEFAULT_OFF, '1')).toBeUndefined();
  });
});
