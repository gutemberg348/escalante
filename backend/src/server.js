import app from './app.js';
import { env } from './config/env.js';
import { closeWhatsAppForRestart, restoreWhatsAppSession } from './messaging/whatsapp.js';
import { startWhatsAppAutomation } from './messaging/automation.js';
import { runMigrations } from './database/migrations.js';

runMigrations();
restoreWhatsAppSession().catch((error) => console.error('Não foi possível restaurar a sessão WhatsApp:', error));
startWhatsAppAutomation();
const server = app.listen(env.API_PORT, () => console.log(`API do Escala CICC em http://localhost:${env.API_PORT}`));
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`A porta ${env.API_PORT} já está sendo usada por outra API. Encerre o processo anterior antes de iniciar novamente.`);
    process.exit(1);
  }
  throw error;
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: salvando a sessão do WhatsApp antes de encerrar.`);
  await closeWhatsAppForRestart();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.once('SIGINT', () => { shutdown('SIGINT'); });
process.once('SIGTERM', () => { shutdown('SIGTERM'); });
