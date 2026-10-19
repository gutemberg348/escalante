export async function sendGroupDocument({ socket, configuredGroups, groupJid, buffer, fileName, caption, onSent }) {
  if (groupJid !== undefined && !configuredGroups.includes(groupJid)) {
    throw new Error('O grupo de destino não está configurado no painel WhatsApp.');
  }
  const destinations = groupJid === undefined ? configuredGroups : [groupJid];
  const safeCaption = caption || 'Escala em PDF.';
  const results = [];
  for (const destination of destinations) {
    const result = await socket.sendMessage(destination, { document: buffer, mimetype: 'application/pdf', fileName, caption: safeCaption });
    onSent(result, destination, safeCaption);
    results.push(result);
  }
  return results;
}
