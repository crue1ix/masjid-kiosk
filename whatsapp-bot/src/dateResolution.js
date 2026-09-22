const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

function monthIndex(monthName) {
  return MONTH_NAMES.indexOf(String(monthName || '').toLowerCase());
}

// Resolves the calendar year for a day mentioned in an announcement (the
// WhatsApp text never includes a year — e.g. "Thursday, September 17th").
// Handles the Dec -> Jan rollover: a message posted in December about
// "January 2nd" programs means next year, not this year. A message posted
// in September about "September 25th" stays the same year.
function resolveYear(monthName, dayNumber, postedAtIso) {
  const posted = new Date(postedAtIso);
  const postedYear = posted.getFullYear();
  const postedMonthIdx = posted.getMonth();
  const eventMonthIdx = monthIndex(monthName);

  let year = postedYear;
  if (eventMonthIdx !== -1 && eventMonthIdx < postedMonthIdx - 1) {
    year = postedYear + 1;
  }

  const mm = String((eventMonthIdx === -1 ? postedMonthIdx : eventMonthIdx) + 1).padStart(2, '0');
  const dd = String(dayNumber).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

module.exports = { resolveYear };
