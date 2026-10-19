import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendGroupDocument } from '../src/messaging/whatsapp-delivery.js';

const first = '120000000000001@g.us';
const second = '120000000000002@g.us';
function delivery() {
  const sent = [];
  const logged = [];
  return { sent, logged, options: {
    configuredGroups: [first, second], buffer: Buffer.from('%PDF-test'), fileName: 'escala.pdf', caption: 'Escala do próximo mês',
    socket: { sendMessage: async (destination, payload) => {
      sent.push({ destination, payload }); return { key: { id: `out-${sent.length}` } };
    } },
    onSent: (result, destination, caption) => logged.push({ result, destination, caption })
  } };
}

test('a generated PDF is delivered and logged only in the requesting group', async () => {
  for (const groupJid of [first, second]) {
    const { sent, logged, options } = delivery();
    const results = await sendGroupDocument({ ...options, groupJid });
    assert.equal(results.length, 1);
    assert.deepEqual(sent.map((item) => item.destination), [groupJid]);
    assert.deepEqual(logged.map((item) => item.destination), [groupJid]);
    assert.equal(sent[0].payload.document, options.buffer);
    assert.equal(sent[0].payload.mimetype, 'application/pdf');
    assert.equal(sent[0].payload.fileName, options.fileName);
  }
});

test('an invalid explicit destination never falls back to broadcasting the PDF', async () => {
  for (const groupJid of ['unknown@g.us', '', null]) {
    const { sent, logged, options } = delivery();
    await assert.rejects(sendGroupDocument({ ...options, groupJid }), /grupo de destino não está configurado/);
    assert.equal(sent.length, 0);
    assert.equal(logged.length, 0);
  }
});

test('scheduled documents without a specific group retain the configured destinations', async () => {
  const { sent, logged, options } = delivery();
  await sendGroupDocument(options);
  assert.deepEqual(sent.map((item) => item.destination), [first, second]);
  assert.deepEqual(logged.map((item) => item.destination), [first, second]);
});
