import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkingRequest } from '../src/messaging/marking-choices.js';

const day = ['DIURNO'];
const night = ['NOTURNO'];
const full = ['DIURNO', 'NOTURNO'];
const choice = (number, periods) => ({ day: number, periods });
const forms = [
  ...['20 dia', 'no dia 20 , dia', '20,dia', '20 de dia', '20 diurno', '20 - diurno', '20 D', '20d', '20dia',
    'dia 20 somente dia pfv', '20 no período diurno', 'de dia no dia 20', '20 das 07h às 19h', '20 07:00-19:00', '20 dia 12h']
    .map(text => [text, [choice(20, day)]]),
  ...['20 noite', '20,noite', '20 à noite', '20 noturno', '20 noturna', '20 N', '20n', '20noite',
    '20 pela noite, por favor!', 'noite no dia 20', '20 das 19h às 07h', '20 19:00-07:00', '20 noite 12 horas']
    .map(text => [text, [choice(20, night)]]),
  ...['20', 'dia 20', '20 24h', '20,24hrs', '20 24hras', '20 24 horas', '20 dia e noite', '20 noite e dia',
    '20 dia/noite', '20 dia noite', '20 ambos os turnos', '20 dia inteiro', '20 integral', '24h dia 20', '20 vinte e quatro horas']
    .map(text => [text, [choice(20, full)]]),
  ['20,21 noite', [choice(20, night), choice(21, night)]],
  ['20 e 21 dia', [choice(20, day), choice(21, day)]],
  ['noite dias 20,21 e 22', [choice(20, night), choice(21, night), choice(22, night)]],
  ['20 noite e 21', [choice(20, night), choice(21, night)]],
  ['20 dia; 21 noite', [choice(20, day), choice(21, night)]],
  ['20 dia\n21 noite', [choice(20, day), choice(21, night)]],
  ['20 dia,21 noite', [choice(20, day), choice(21, night)]],
  ['20 noite;21', [choice(20, night), choice(21, full)]],
  ['20;21 noite', [choice(20, full), choice(21, night)]],
  ['20 dia;20 noite', [choice(20, full)]],
  ['20;20 dia', [choice(20, day)]],
  ['20/09 noite', [choice(20, night)]],
  ['20/09/2028 dia', [choice(20, day)]],
  ['24 noite', [choice(24, night)]],
  ['dia 24, 24h', [choice(24, full)]]
];
for (const [input, expected] of forms) test(`selection: ${input}`, () => {
  const result = parseMarkingRequest(input, { month: 9, year: 2028 });
  assert.equal(result.error, null);
  assert.deepEqual(result.choices, expected);
});
for (const input of ['20 dia ou noite', '20 12h', '20, tarde', 'manhã dia 20', '20 08h às 20h', '20 08 as 20',
  '20 a 22 noite', '20-22', '20 até 22', '32 noite', '0 dia', '31/09 noite', '20/10 noite', '20/09/2027 noite',
  '20 dia; 32 noite', '20 dia; 21 notie', '20, notie', 'não marque dia 20', '20 noite?',
  '20 exceto noite', '20 dia; 21 12h']) test(`uncertain selection refuses: ${input}`, () => {
  const result = parseMarkingRequest(input, { month: 9, year: 2028 });
  assert.ok(result.error);
  assert.deepEqual(result.choices, []);
});
