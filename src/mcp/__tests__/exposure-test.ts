import {
  exposedConnections,
  findExposed,
  isExposed,
  ServiceLike,
} from '../exposure';
import { stableId } from '../identity';

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
      id: stableId(services[0]),
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
    expect(exposed.map(c => c.id)).toEqual([stableId(services[0])]);
  });
});

describe('findExposed', () => {
  const services = [
    service(1, { host: 'a.example.com', protocol: 'sftp', port: 22, remotePath: '/' }),
    service(2, { host: 'b.example.com', protocol: 'sftp', port: 22, remotePath: '/',
                 mcp: { exposed: false } }),
  ];

  it('resolves an exposed id', () => {
    expect(findExposed(services, DEFAULT_ON, stableId(services[0]))!.id).toBe(1);
  });

  it('treats a hidden connection as absent, not forbidden', () => {
    // Indistinguishable from an id that never existed, on purpose.
    expect(findExposed(services, DEFAULT_ON, stableId(services[1]))).toBeUndefined();
    expect(findExposed(services, DEFAULT_ON, '404')).toBeUndefined();
  });

  it('stops resolving an id once the setting withdraws it', () => {
    const id = stableId(services[0]);
    expect(findExposed(services, DEFAULT_ON, id)).toBeDefined();
    expect(findExposed(services, DEFAULT_OFF, id)).toBeUndefined();
  });

  it('no longer answers to the editor\u2019s own connection number', () => {
    // Which is the whole point: the number means a different server after a
    // reload, and an agent holding one would read somewhere it never meant to.
    expect(findExposed(services, DEFAULT_ON, '1')).toBeUndefined();
  });
});

describe('addressing a connection by name', () => {
  const site = (id: number, name: string, workspace: string) =>
    service(id, { name, protocol: 'sftp', host: `${name}.example.com`,
                  port: 22, remotePath: '/srv', workspace });

  it('takes the name an agent read in the listing', () => {
    const services = [site(1, 'staging', '/work/a'), site(2, 'live', '/work/b')];

    expect(findExposed(services, DEFAULT_ON, 'staging')).toBe(services[0]);
    expect(findExposed(services, DEFAULT_ON, 'live')).toBe(services[1]);
  });

  it('refuses a name that two connections share', () => {
    // Two checkouts of one project, both called the same thing. Guessing
    // between them is how an agent reads the wrong server.
    const twice = [
      site(1, 'cashtrack', '/work/one'),
      site(2, 'cashtrack', '/work/two'),
    ];

    expect(findExposed(twice, DEFAULT_ON, 'cashtrack')).toBeUndefined();
    // Their ids still differ, and each still resolves.
    expect(stableId(twice[0])).not.toBe(stableId(twice[1]));
    expect(findExposed(twice, DEFAULT_ON, stableId(twice[1]))).toBe(twice[1]);
  });
});

describe('the id a connection keeps', () => {
  const config = {
    name: 'events', protocol: 'sftp', host: 'univers.example.com',
    port: 2121, remotePath: '/httpdocs/stage', workspace: '/work/events',
  };

  it('survives the editor renumbering everything', () => {
    // What happens on every reload: the same connection, a different number.
    expect(stableId(service(11, config))).toBe(stableId(service(104, config)));
  });

  it('changes when the connection points somewhere else', () => {
    const elsewhere = { ...config, remotePath: '/httpdocs/live' };
    const otherHost = { ...config, host: 'other.example.com' };
    const otherProject = { ...config, workspace: '/work/other' };

    [elsewhere, otherHost, otherProject].forEach(changed =>
      expect(stableId(service(1, changed))).not.toBe(stableId(service(1, config)))
    );
  });
});

describe('connections that look alike', () => {
  const at = (over: any) =>
    service(1, {
      name: 'site', protocol: 'sftp', host: 'shared.example.com', port: 2121,
      username: 'one', remotePath: '/httpdocs', workspace: '/work/remote',
      ...over,
    });

  it('tells two accounts on one host apart', () => {
    // Shared hosting: a dozen accounts, each with its own `/httpdocs`. Without
    // the username these collapse into one id, and whichever loaded first
    // answers for all of them - which is a read of somebody else's server.
    expect(stableId(at({ username: 'two' }))).not.toBe(stableId(at({})));
  });

  it('tells two names for one target apart', () => {
    // Both rows are listed, so both have to be addressable.
    expect(stableId(at({ name: 'other' }))).not.toBe(stableId(at({})));
  });

  it('gives every connection in a real listing its own id', () => {
    // The shapes that collided when this was first written, from a listing of
    // 104 connections: same host, same path, different accounts.
    const listing = [
      at({ name: 'gaydoul-group.ch', username: 'gaydoulgro' }),
      at({ name: 'fondationgaydoul.ch', username: 'fondationg' }),
      at({ name: 'ratzinger.cc', username: 'ratzing' }),
      at({ name: 'norges-spark.ch', username: 'norgess' }),
      at({ name: 'metanet.st-poelten.at', username: 'dbstpoe' }),
      at({ name: 'st-poelten.at', username: 'dbstpoe' }),
    ];

    const ids = listing.map(stableId);
    expect(new Set(ids).size).toBe(listing.length);
  });
});

describe('an id that somehow means two connections', () => {
  it('resolves to neither, rather than to whichever came first', () => {
    const twin = () => ({
      id: 1,
      name: 'same',
      workspace: '/work',
      baseDir: '/work',
      getConfig: () => ({
        name: 'same', protocol: 'sftp', host: 'h', port: 22,
        username: 'u', remotePath: '/',
      }),
    });
    const pair = [twin(), twin()] as any;

    expect(stableId(pair[0])).toBe(stableId(pair[1]));
    expect(findExposed(pair, DEFAULT_ON, stableId(pair[0]))).toBeUndefined();
  });
});
