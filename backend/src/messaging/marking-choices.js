const both = ['DIURNO', 'NOTURNO'];
const guidance = 'Não entendi com segurança os dias e turnos. Nenhuma marcação foi feita. Use: "20 dia", "20 noite", "20 24h" ou "20 dia; 21 noite".';

// Parse the whole selection before any assignment is written. Explicit periods
// belong to the adjacent list of days; semicolons/newlines start a new list.
export function parseMarkingRequest(body, { month = null, year = null, today = null } = {}) {
  const currentDate = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)
    ? new Date(`${today}T12:00:00`)
    : today instanceof Date ? today : new Date();
  const relativeDate = (offset) => {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + offset, 12);
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  };
  let text = String(body ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/@\S+/g, ' ').replace(/\r?\n/g, ';').replace(/[–—]/g, '-')
    .replace(/["'“”‘’]/g, ' ').replace(/\?+\s*$/, ' ')
    .replace(/\b(?:NO\s+DIA\s+DE\s+|DIA\s+DE\s+)?(?:HOJE|HOJ|HJ)\b/g, relativeDate(0))
    .replace(/\bAMANHA\b/g, relativeDate(1));
  const hasNumber = /\d/.test(text);
  const invalid = (message = guidance) => ({ choices: [], error: message });
  if (hasNumber && /\?|\b(?:OU|TALVEZ|NAO|EXCETO|MENOS|CANCELA\w*|RETIRA\w*|REMOVE\w*)\b/.test(text)) return invalid();
  // Consume clock ranges and durations before looking for calendar days.
  text = text
    .replace(/(\d)(DIA|NOITE|DIURNO|NOTURNO)\b/g, '$1 $2')
    .replace(/\b0?7(?:(?:H|:)(?:00)?)?\s*(?:AS|A|ATE|-)\s*19(?:(?:H|:)(?:00)?)?\b/g, ' SHIFT_DAY ')
    .replace(/\b19(?:(?:H|:)(?:00)?)?\s*(?:AS|A|ATE|-)\s*0?7(?:(?:H|:)(?:00)?)?\b/g, ' SHIFT_NIGHT ')
    .replace(/\b(?:24\s*(?:HORAS?|HRAS?|HRS?|H)|VINTE E QUATRO HORAS?)\b/g, ' SHIFT_BOTH ')
    .replace(/\b(?:DIA(?:\s+E|\s*\/)?\s*NOITE|NOITE\s+E\s+DIA|DIURNO\s+E\s+NOTURNO|AMBOS(?:\s+OS)?\s+TURNOS|DIA\s+(?:INTEIRO|TODO)|INTEGRAL)\b/g, ' SHIFT_BOTH ')
    .replace(/\b12\s*(?:HORAS?|HRS?|H)\b/g, ' DURATION_TWELVE ')
    // Com uma duração explícita, "dia" é o turno, não o prefixo da data.
    // Ex.: 12h "dia" hoje -> somente DIURNO na data atual.
    .replace(/\b(DURATION_TWELVE)\s+DIA\s+(?=\d)/g, '$1 SHIFT_DAY ')
    .replace(/\b(?:DIAS?|DATA)\s*(?=\d)/g, ' ')
    .replace(/\b(?:NOITE|NOTURNO|NOTURNA)\b/g, ' SHIFT_NIGHT ')
    .replace(/\b(?:DIA|DIURNO|DIURNA)\b/g, ' SHIFT_DAY ');
  if (/\b(?:MANHA|TARDE|MADRUGADA)\b|\d\s*(?:A|AS|ATE|-)\s*\d|\b\d+(?::\d+|H(?:\d+)?)\b/.test(text)) return invalid();
  // Ignore natural command introductions/names, but validate all text from the
  // first requested day/period onwards (including a typo after a valid choice).
  const start = text.search(/\b(?:\d|SHIFT_|DURATION_)/);
  if (start < 0) return { choices: [], error: null };
  text = text.slice(start)
    .replace(/\b(?:POR\s+FAVOR|POR\s+GENTILEZA|PFV|PFF|OBRIGADO|OBRIGADA)\b/g, ' ')
    .replace(/\b(?:NO|NOS|NA|NAS|DO|DOS|DA|DAS|DE|A|AS|AO|PELA|PELO|TURNO|PERIODO|SO|SOMENTE|APENAS)\b/g, ' ')
    .replace(/\b(?:D|DIU)\b/g, ' SHIFT_DAY ')
    .replace(/\b(?:N|NOT)\b/g, ' SHIFT_NIGHT ')
    .replace(/(\d)([DN])\b/g, '$1 SHIFT_$2 ')
    .replace(/SHIFT_D\b/g, 'SHIFT_DAY').replace(/SHIFT_N\b/g, 'SHIFT_NIGHT');
  // Date ranges are deliberately not guessed. Hyphens only separate a day
  // from a named period; slash dates are validated against the active month.
  const tokenPattern = /\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d+|SHIFT_DAY|SHIFT_NIGHT|SHIFT_BOTH|DURATION_TWELVE|[;,]|\bE\b/g;
  const tokens = [...text.matchAll(tokenPattern)];
  const residue = text.replace(tokenPattern, '').replace(/[\s.!:\-]/g, '');
  if (residue) return invalid();
  const selections = new Map();
  let pending = [];
  let inherited = null;
  let durationTwelve = false;
  const add = (day, periods, explicit) => {
    const previous = selections.get(day);
    if (!previous || (explicit && !previous.explicit)) selections.set(day, { periods: new Set(periods), explicit });
    else if (explicit === previous.explicit) periods.forEach(period => previous.periods.add(period));
  };
  const flush = (periods = inherited, explicit = Boolean(periods)) => {
    if (durationTwelve && (!periods || periods.length !== 1)) return false;
    for (const day of pending) add(day, periods ?? both, explicit);
    pending = [];
    durationTwelve = false;
    return true;
  };
  for (const match of tokens) {
    const token = match[0];
    if (token === ';') {
      if (!flush()) return invalid();
      inherited = null;
    } else if (token === ',' || token === 'E') {
      continue;
    } else if (token === 'DURATION_TWELVE') {
      durationTwelve = true;
    } else if (token.startsWith('SHIFT_')) {
      const periods = token === 'SHIFT_DAY' ? ['DIURNO'] : token === 'SHIFT_NIGHT' ? ['NOTURNO'] : both;
      // Adjacent contradictory periods must be written explicitly as "dia e noite".
      if (!pending.length && inherited && inherited.join() !== periods.join()) return invalid();
      if (!flush(periods, true)) return invalid();
      inherited = periods;
    } else {
      const parts = token.split('/').map(Number);
      const [day, specifiedMonth, specifiedYear] = parts;
      if (day < 1 || day > 31 || (specifiedMonth !== undefined && (specifiedMonth < 1 || specifiedMonth > 12))) return invalid();
      if ((month && specifiedMonth && month !== specifiedMonth) || (year && specifiedYear && year !== specifiedYear)) {
        return invalid('A data informada não pertence ao mês ativo da escala. Nenhuma marcação foi feita. Consulte /escala para conferir o mês.');
      }
      const selectedMonth = specifiedMonth ?? month;
      const selectedYear = specifiedYear ?? year ?? 2000;
      if (selectedMonth && day > new Date(selectedYear, selectedMonth, 0).getDate()) return invalid('Essa data não existe no mês da escala. Nenhuma marcação foi feita.');
      pending.push(day);
    }
  }
  if (!flush()) return invalid();
  if (!selections.size) return invalid();
  return { choices: [...selections].sort(([a], [b]) => a - b)
    .map(([day, selection]) => ({ day, periods: both.filter(period => selection.periods.has(period)) })), error: null };
}

export function parseNaturalChoices(body) {
  return parseMarkingRequest(body).choices;
}
