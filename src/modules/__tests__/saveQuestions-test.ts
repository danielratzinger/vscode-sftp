import { SaveQuestions } from '../saveQuestions';

describe('the question asked about a save', () => {
  let clock = 0;
  const questions = () => new SaveQuestions(15000, () => clock);

  beforeEach(() => {
    clock = 1000;
  });

  it('is not asked twice while the first is on screen', () => {
    const q = questions();
    expect(q.begin('/a.env')).toBeDefined();
    clock += 5000;
    expect(q.begin('/a.env')).toBeUndefined();
    expect(q.begin('/b.env')).toBeDefined();
  });

  // The editor hides an unanswered warning; the save after that has to ask.
  it('is asked again once the first may have been tucked away', () => {
    const q = questions();
    q.begin('/a.env');
    clock += 15000;
    expect(q.begin('/a.env')).toBeDefined();
  });

  it('is asked again as soon as the first is answered', () => {
    const q = questions();
    const token = q.begin('/a.env')!;
    q.end('/a.env', token);
    expect(q.begin('/a.env')).toBeDefined();
  });

  it('keeps a newer question when an older one is answered late', () => {
    const q = questions();
    const old = q.begin('/a.env')!;
    clock += 20000;
    q.begin('/a.env');
    q.end('/a.env', old);
    clock += 1000;
    expect(q.begin('/a.env')).toBeUndefined();
  });
});
