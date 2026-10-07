const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const offsetPattern = /^(.*?)(Z|[+-]\d{2}:\d{2})$/;
export function formatter(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function parts(date, format) {
  return Object.fromEntries(format.formatToParts(new Date(date)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function utc(p) { const d = new Date(0); d.setUTCFullYear(p.year, p.month - 1, p.day); d.setUTCHours(p.hour, p.minute, p.second, p.ms ?? 0); return d.getTime(); }
export function parseTime(value, timezone = 'Etc/UTC') {
  const format = formatter(timezone), offset = offsetPattern.exec(value), match = localPattern.exec(offset ? offset[1] : value);
  if (!match) throw new Error('Use an ISO date-time with seconds; supply an offset for ambiguous local times');
  const p = { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +match[6], ms: +(match[7] ?? '').padEnd(3, '0') };
  const anchor = utc(p), d = new Date(anchor);
  if (p.month < 1 || p.month > 12 || p.hour > 23 || p.minute > 59 || p.second > 59 || d.getUTCFullYear() !== p.year || d.getUTCMonth() + 1 !== p.month || d.getUTCDate() !== p.day) throw new Error('Invalid calendar time');
  if (offset) {
    let minutes = 0;
    if (offset[2] !== 'Z') {
      const h = +offset[2].slice(1, 3), m = +offset[2].slice(4);
      if (h > 14 || m > 59 || (h === 14 && m !== 0)) throw new Error('Invalid UTC offset');
      minutes = (h * 60 + m) * (offset[2][0] === '+' ? 1 : -1);
    }
    return anchor - minutes * 60_000;
  }
  const offsets = new Set([-48, -24, 0, 24, 48].map(h => { const time = anchor + h * 3600_000; return utc(parts(time, format)) - Math.floor(time / 1000) * 1000; }));
  const matches = [...offsets].map(o => anchor - o).filter(t => {
    const q = parts(t, format); return ['year', 'month', 'day', 'hour', 'minute', 'second'].every(k => q[k] === p[k]);
  });
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous local time; supply an explicit UTC offset' : 'Nonexistent local time; supply a valid time');
  return matches[0];
}
export function displayTime(time, timezone) { return formatter(timezone).format(new Date(time)); }
