// Date fields are stored as UTC-midnight timestamps, but represent calendar
// dates in the application's configured time zone.
const TIMEZONE = process.env.APP_TIMEZONE || "Africa/Lagos";

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function addDateDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateHasPassed(date, now = new Date()) {
  return new Date(date).getTime() < localDateKey(now).getTime();
}

module.exports = { TIMEZONE, localDateKey, addDateDays, dateHasPassed };
