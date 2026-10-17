describe('configured calendar-date formatting', () => {
  const originalTimezone = process.env.APP_TIMEZONE;

  afterEach(() => {
    if (originalTimezone === undefined) delete process.env.APP_TIMEZONE;
    else process.env.APP_TIMEZONE = originalTimezone;
    jest.resetModules();
  });

  it('keeps a UTC-midnight calendar date on the same day in a western timezone', () => {
    process.env.APP_TIMEZONE = 'America/Los_Angeles';
    jest.resetModules();
    const { fmt } = require('../config/format');

    expect(fmt(new Date('2026-10-18T00:00:00.000Z'))).toBe('18 Oct 2026');
  });
});
