// "05 Oct 2026" — the one date format used on every page and in every PDF
const { TIMEZONE } = require("./dateBoundaries");
const fmt = (d) => {
  const date = new Date(d);
  // Date-only values are stored at UTC midnight and must retain that calendar
  // day even when the configured application time zone is west of UTC.
  const isCalendarDate =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  return date.toLocaleDateString("en-GB", {
    timeZone: isCalendarDate ? "UTC" : TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

module.exports = { fmt };
