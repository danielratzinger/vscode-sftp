import { dataHost, isUnroutable } from '../pasv';

describe('isUnroutable', () => {
  it('knows the ranges only their own network can reach', () => {
    ['10.8.169.245', '192.168.1.10', '172.16.0.1', '172.31.255.254', '127.0.0.1',
     '169.254.3.4', '100.64.0.1', '0.0.0.0'].forEach(address => {
      expect(isUnroutable(address)).toBe(true);
    });
  });

  it('leaves public addresses, and the edges of those ranges, alone', () => {
    ['94.126.16.106', '172.15.0.1', '172.32.0.1', '192.167.1.1', '100.63.0.1',
     '100.128.0.1', '169.253.0.1', '11.0.0.1'].forEach(address => {
      expect(isUnroutable(address)).toBe(false);
    });
  });

  it('says nothing about what is not an IPv4 address', () => {
    ['', 'ftp.example.com', '1.2.3', '1.2.3.4.5', '999.1.1.1', '::1'].forEach(
      address => expect(isUnroutable(address)).toBe(false)
    );
  });
});

describe('dataHost', () => {
  it('takes the control address when the advertised one cannot be reached', () => {
    // The case from tws.law: ProFTPD behind NAT, announcing the address it knows
    // itself by.
    expect(dataHost('10.8.169.245', '185.15.44.2')).toBe('185.15.44.2');
  });

  it('believes an address that could be right', () => {
    expect(dataHost('185.15.44.2', '185.15.44.2')).toBe('185.15.44.2');
    expect(dataHost('185.15.44.9', '185.15.44.2')).toBe('185.15.44.9');
  });

  it('leaves a server on our own network to speak for itself', () => {
    // Both private: we are inside, and 192.168.1.50 is very likely where the
    // data connection belongs.
    expect(dataHost('192.168.1.50', '192.168.1.1')).toBe('192.168.1.50');
  });

  it('has nothing to offer when the control address is unknown', () => {
    expect(dataHost('10.0.0.1', undefined)).toBe('10.0.0.1');
    expect(dataHost('10.0.0.1', '')).toBe('10.0.0.1');
  });

  it('works through an IPv6-mapped control address', () => {
    expect(dataHost('10.8.169.245', '::ffff:185.15.44.2')).toBe('::ffff:185.15.44.2');
  });
});
