import { localTime, offsetAt } from '../localTime';

/**
 * Whatever zone the machine running this is in: a summer and a winter moment,
 * so a zone with daylight saving is checked at both of its offsets.
 */
describe('a moment as the clock on the wall shows it', () => {
  const summer = new Date(2026, 9, 14, 11, 1, 18).getTime();
  const winter = new Date(2026, 0, 14, 11, 1, 18).getTime();

  it('reads as the local time it is', () => {
    expect(localTime(summer)).toMatch(/^2026-10-14 11:01 [+-]\d\d:\d\d$/);
    expect(localTime(summer, true)).toMatch(/^2026-10-14 11:01:18 [+-]\d\d:\d\d$/);
  });

  it('says its offset, and the offset is the one in force then', () => {
    const minutes = -new Date(summer).getTimezoneOffset();
    const expected =
      (minutes < 0 ? '-' : '+') +
      String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0') +
      ':' +
      String(Math.abs(minutes) % 60).padStart(2, '0');
    expect(offsetAt(new Date(summer))).toBe(expected);
  });

  // The point of carrying the offset: the text names one moment, the same
  // one the number does.
  it('names the same moment as the number it came from', () => {
    for (const ms of [summer, winter]) {
      const [date, clock, offset] = localTime(ms, true).split(' ');
      expect(Date.parse(`${date}T${clock}${offset}`)).toBe(ms);
    }
  });
});
