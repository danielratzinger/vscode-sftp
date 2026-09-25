import { describeSize } from '../size';

describe('a number of bytes as somebody would say it', () => {
  it('counts small things exactly', () => {
    expect(describeSize(0)).toBe('0 bytes');
    expect(describeSize(1023)).toBe('1023 bytes');
  });

  it('rounds kilobytes, where a decimal would say nothing', () => {
    expect(describeSize(1024)).toBe('1 KB');
    expect(describeSize(48 * 1024 + 700)).toBe('49 KB');
  });

  it('keeps one decimal for megabytes, and drops it when it is nothing', () => {
    expect(describeSize(50 * 1024 * 1024)).toBe('50 MB');
    expect(describeSize(Math.round(48.24 * 1024 * 1024))).toBe('48.2 MB');
  });
});
