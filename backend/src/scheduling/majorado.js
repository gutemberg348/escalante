import dayjs from 'dayjs';

const fixedBrazilAndParaibaHolidays = new Set([
  '01-01', '04-21', '05-01', '06-24', '08-05', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'
]);

function easterSunday(year) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return dayjs(`${year}-03-01`).add(h + l - 7 * m - 1, 'day');
}

export function isMajoradoDate(serviceDate) {
  const date = dayjs(serviceDate);
  if (!date.isValid()) return false;
  if ([0, 5, 6].includes(date.day())) return true;
  if (fixedBrazilAndParaibaHolidays.has(date.format('MM-DD'))) return true;
  const easter = easterSunday(date.year());
  return [easter.subtract(2, 'day').format('YYYY-MM-DD'), easter.add(60, 'day').format('YYYY-MM-DD')].includes(date.format('YYYY-MM-DD'));
}
