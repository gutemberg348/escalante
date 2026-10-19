import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequestedMonth } from '../src/messaging/month-selector.js';
import { parseMarkingRequest } from '../src/messaging/marking-choices.js';

const options = { today: new Date(2026, 9, 19), defaultYear: 2026 };
test('month names, numbers and relative phrases leave only the requested day and shift', () => {
  for (const selector of ['próximo mês', 'mês que vem', 'mes q vem', 'mes vem', 'novembro', 'mês 11', 'mês de novembro', '11/2026', '2026-11']) {
    const result = parseRequestedMonth(`marcar dia 20 noite no ${selector}`, options);
    assert.equal(result.month, 11, selector);
    assert.equal(result.year, 2026, selector);
    const parsed = parseMarkingRequest(result.text, result);
    assert.equal(parsed.error, null, selector);
    assert.deepEqual(parsed.choices, [{ day: 20, periods: ['NOTURNO'] }], selector);
  }
});
test('relative month means the calendar month including December to January', () => {
  for (const selector of ['este mês', 'esse mês', 'neste mês', 'deste mês', 'desse mês', 'mês atual']) {
    assert.equal(parseRequestedMonth(selector, options).month, 10);
  }
  const january = parseRequestedMonth('mês que vem', { today: new Date(2026, 11, 31), defaultYear: 2030 });
  assert.equal(january.month, 1);
  assert.equal(january.year, 2027);
});
test('numeric-only month is accepted for PDF selection, never inferred from a booking day', () => {
  assert.equal(parseRequestedMonth('11', { ...options, selectorOnly: true }).month, 11);
  assert.equal(parseRequestedMonth('dia 11 noite', options).requested, false);
  assert.equal(parseRequestedMonth('20 24h', options).requested, false);
});
test('explicit years and full service dates are preserved and validated', () => {
  assert.equal(parseRequestedMonth('dia 20 março de 2028', options).year, 2028);
  const request = parseRequestedMonth('dia 29/02/2028 dia', options);
  assert.equal(request.month, 2);
  assert.equal(request.year, 2028);
  assert.equal(parseMarkingRequest(request.text, request).error, null);
  const invalid = parseRequestedMonth('dia 31 novembro', options);
  assert.match(parseMarkingRequest(invalid.text, invalid).error, /não existe/);
});
test('contradictory and invalid month requests never silently fall back', () => {
  for (const phrase of ['dia 20 mês 13', 'dia 20 mês 0', 'dia 20 novembro e dezembro', '20/11/2026 noite mês 10', 'novembro 2026 e novembro 2027']) {
    assert.ok(parseRequestedMonth(phrase, options).error, phrase);
  }
});
test('months inside names and annotations are not selectors', () => {
  assert.equal(parseRequestedMonth('@Novembro dia 20 (Sgt Março)', options).requested, false);
});
