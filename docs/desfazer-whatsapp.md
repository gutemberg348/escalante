# Desfazer no WhatsApp

`/desfazer`, `/desfaz` e `@Escalante última forma` revertem a última alteração concluída do remetente real no grupo atual. Não há reversão de comandos de outro remetente por menção ou citação. Consultas não entram na pilha; chamadas consecutivas desfazem ações anteriores. Não existe refazer.

A migração `019_whatsapp_command_history` cria o histórico persistente e o diário de alterações. É aplicada pelo fluxo normal de migrações na inicialização; não requer SQL manual. Alterações anteriores à atualização não podem ser desfeitas por esse mecanismo.

`command-history.js` instala triggers TEMP na conexão SQLite. Uma função SQL lê o identificador da operação em AsyncLocalStorage, inclusive através de callbacks assíncronos. Assim, gravações do painel, automações e comandos simultâneos não são atribuídas ao comando errado. Somente tabelas operacionais e uma lista explícita de configurações são registradas. Credenciais, sessões, identidades, autorizações do bot, mensagens enviadas, auditoria e histórico administrativo não são restaurados.

Antes da reversão, o estado final dos registros é comparado com o banco atual. As alterações são revertidas em ordem inversa dentro de uma transação, preservando chaves e tipos de serviço. Restrições de unicidade e referências, capacidade das colunas, homologação, situação do militar, limite de horas e fila ativa são conferidos. Um conflito desfaz a transação inteira. A reversão gera auditoria própria e marca a operação como desfeita.

Cada operação armazena a permissão usada pelo remetente. Operações administrativas exigem novamente a permissão correspondente. O processamento normal de mensagens mantém a deduplicação, inclusive para `/desfazer`.

Geração confirmada por SIM é registrada como uma única operação. Alterações no mês criado por outros comandos podem bloquear a reversão. Mensagens/PDFs já enviados não são recolhidos. Quando há um único mês afetado ainda existente, é enviado um PDF atualizado com o layout habitual.

Operações em andamento ou interrompidas não são ultrapassadas silenciosamente para desfazer uma ação mais antiga. Se a execução foi interrompida por reinício, o usuário recebe orientação para conferir a escala no painel. Não existe recuperação automática de operação incompleta.

Validação: `backend/test/command-history.test.js` usa SQLite temporário e cobre reversão atômica, conflito de vagas, permissões, concorrência e persistência em outro processo; `whatsapp-mentions.test.js` cobre os comandos pelo recebimento real do bot, incluindo citação, mês e envio do PDF.
