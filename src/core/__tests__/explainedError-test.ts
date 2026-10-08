import { forLog, markExplained } from '../explainedError';

describe('forLog', () => {
  it('keeps the trace of an error nobody has explained', () => {
    const error = new Error('cannot read properties of undefined');
    expect(forLog(error)).toBe(error.stack);
    expect(forLog(error)).toContain('explainedError-test');
  });

  it('writes an explained error as its message alone', () => {
    const error = markExplained(new Error('[orbit.metanet.ch]: connect ETIMEDOUT 80.74.153.100:2121'));
    expect(forLog(error)).toBe('[orbit.metanet.ch]: connect ETIMEDOUT 80.74.153.100:2121');
  });

  it('keeps the trace when it is asked for', () => {
    const error = markExplained(new Error('[orbit.metanet.ch]: connect ETIMEDOUT'));
    expect(forLog(error, true)).toBe(error.stack);
  });

  // Marked without changing what callers read off it.
  it('leaves the error as it was otherwise', () => {
    const error: any = new Error('refused');
    error.code = 'ECONNREFUSED';
    markExplained(error);

    expect(error.code).toBe('ECONNREFUSED');
    expect(Object.keys(error)).toEqual(['code']);
    expect(JSON.stringify(error)).toBe('{"code":"ECONNREFUSED"}');
  });
});
