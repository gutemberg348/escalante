const names = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

// Return the remaining day/shift text separately so month numbers can never
// accidentally become additional booking days. Mentions and notes are opaque.
export function parseRequestedMonth(value, { today = new Date(), defaultYear = today.getFullYear(), selectorOnly = false } = {}) {
  const original = String(value ?? '');
  let searchable = original.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/@\S+|\([^)]*\)/g, (part) => ' '.repeat(part.length));
  const ranges = [];
  const months = [];
  const prefix = '(?:(?:PARA|PRA|PRO|DO|DE|NO|EM)\\s+(?:(?:O|A)\\s+)?)?';
  const pattern = new RegExp(`\\b${prefix}(PROXIMO\\s+MES|MES\\s+(?:(?:QUE|Q)\\s+)?VEM|(?:ESTE|ESSE|NESTE|NESSE|DESTE|DESSE)\\s+MES|MES\\s+ATUAL|(?:MES\\s+(?:DE\\s+)?)?(?:${names.join('|')})(?:\\s+(?:DE\\s+)?20\\d{2})?|MES\\s+(?:DE\\s+)?\\d{1,2}(?:\\s*(?:/|-|DE|EM)\\s*20\\d{2})?|\\d{1,2}\\s*[/\\-]\\s*20\\d{2}|20\\d{2}-\\d{1,2})\\b`, 'g');
  // Full dates retain their day and are also validated by the marking parser.
  for (const match of searchable.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/g)) {
    months.push({ month: Number(match[2]), year: Number(match[3] || defaultYear) });
    searchable = searchable.slice(0, match.index) + ' '.repeat(match[0].length) + searchable.slice(match.index + match[0].length);
  }
  for (const match of searchable.matchAll(pattern)) {
    const phrase = match[1];
    let month;
    let year = defaultYear;
    if (/^(?:PROXIMO\s+MES|MES\s+(?:(?:QUE|Q)\s+)?VEM)$/.test(phrase)) {
      const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      month = next.getMonth() + 1;
      year = next.getFullYear();
    } else if (/^(?:ESTE|ESSE|NESTE|NESSE|DESTE|DESSE)\b|ATUAL/.test(phrase)) {
      month = today.getMonth() + 1;
      year = today.getFullYear();
    } else {
      const named = names.findIndex((name) => new RegExp(`\\b${name}\\b`).test(phrase));
      const explicitYear = phrase.match(/\b20\d{2}\b/);
      year = Number(explicitYear?.[0] || defaultYear);
      month = named >= 0 ? named + 1 : Number(phrase.replace(/20\d{2}/, '').match(/\d{1,2}/)?.[0]);
    }
    months.push({ month, year });
    ranges.push([match.index, match.index + match[0].length]);
  }
  if (!months.length && selectorOnly) {
    const bare = searchable.trim().match(/^(?:(?:DO|DE|NO|EM)\s+)?(\d{1,2})[.!?]?$/);
    if (bare) {
      months.push({ month: Number(bare[1]), year: defaultYear });
      ranges.push([0, original.length]);
    }
  }
  if (!months.length) return { text: original, requested: false };
  if (months.some(({ month, year }) => month < 1 || month > 12 || !Number.isInteger(month) || year < 2000 || year > 2099)) {
    return { error: 'Mês inválido. Informe um mês de 1 a 12 ou seu nome. Nenhuma alteração foi feita.' };
  }
  if (new Set(months.map(({ month, year }) => `${year}-${month}`)).size > 1) {
    return { error: 'Informe somente um mês por mensagem. Nenhuma alteração foi feita.' };
  }
  let text = original;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + ' ' + text.slice(end);
  return { ...months[0], text: text.trim(), requested: true };
}
