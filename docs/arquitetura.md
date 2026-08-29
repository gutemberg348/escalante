# Arquitetura do sistema

Este projeto é um painel web para organizar escala e conectar um único WhatsApp operacional. A regra é simples: o SQLite é a fonte oficial. O WhatsApp é apenas o canal de conexão e de mensagens.

## Visão geral

```text
Navegador (React + Vite)
        │  cookie HttpOnly
        ▼
API (Express)
 ├── autenticação e perfis
 ├── efetivo / antiguidade / competências / horários
 ├── configurações do WhatsApp
 └── SQLite (dados oficiais e auditoria)
        │
        ▼
WhatsApp Web (Baileys)
 ├── QR Code mostrado no painel
 ├── sessão local persistida em data/whatsapp-auth
 └── grupos disponíveis após o aparelho conectar
```

## Pastas importantes

| Local | Responsabilidade |
|---|---|
| `frontend/` | Painel React exibido no navegador. |
| `backend/src/app.js` | Ponto central da API e registro das rotas. |
| `backend/src/modules/` | Recursos da API: autenticação, efetivo, antiguidade, competências, horários e WhatsApp. |
| `backend/src/messaging/whatsapp.js` | Conexão QR, persistência da sessão e consulta dos grupos. |
| `backend/src/database/index.js` | Banco SQLite, tabelas e auditoria. |
| `data/escala.sqlite` | Banco com os dados oficiais. Não apagar em produção. |
| `data/whatsapp-auth/` | Chaves de sessão do WhatsApp. É criado após a primeira conexão e não vai para o Git. |
| `.env` | Somente infraestrutura e credenciais iniciais do administrador. |

## Como iniciar

1. Use o **Node.js 20 ou superior**. O conector do WhatsApp exige Node 20+.
2. Revise o arquivo `.env` na raiz. Ajuste no mínimo `SESSION_SECRET`, `ADMIN_EMAIL` e `ADMIN_INITIAL_PASSWORD`.
3. Instale as dependências:

   ```bash
   npm install
   ```

4. Crie os dados iniciais:

   ```bash
   npm run seed
   ```

5. Inicie o painel e a API:

   ```bash
   npm run dev
   ```

6. Abra `http://localhost:5173`.

O seed cria o usuário administrador uma única vez. Depois do primeiro acesso, altere a senha pelo fluxo administrativo quando ele estiver disponível. Não coloque telefones, JIDs, grupo ou regras de escala no `.env`.

### Comandos do projeto

| Comando | Uso |
|---|---|
| `npm run dev` | Inicia API e painel juntos, sem reiniciar automaticamente a API. |
| `npm run dev:api` | Inicia somente a API estável na porta 3000. |
| `npm run dev:api:watch` | Inicia somente a API com reinício automático ao editar arquivos de `src`. |
| `npm run dev:web` | Inicia somente o painel na porta 5173. |
| `npm run migrate` | Aplica migrations manualmente quando o projeto receber uma alteração de banco. Não roda ao iniciar a API. |
| `npm run seed` | Cria administrador, alas e efetivo inicial sem duplicar. |
| `npm run seed:schedule -- 2026` | Cria as 12 competências e todos os horários diurnos/noturnos de 2026 sem duplicar. Troque o ano quando necessário. |
| `npm run build` | Valida e gera o painel de produção. |

### Node 20 somente neste projeto

Para não alterar os outros projetos que usam versões diferentes de Node, este repositório já está fixado em Node `20.19.0` por meio do campo `volta` no `package.json`.

Instale o Volta uma vez no Windows:

```powershell
winget install Volta.Volta
```

Depois, feche e abra o terminal. Dentro desta pasta, execute:

```powershell
volta pin node@20.19.0
node --version
```

O resultado deve ser `v20.19.0` nesta pasta. Em qualquer outro projeto sem esse campo `volta`, o Volta continuará usando a versão definida por aquele projeto ou a versão padrão dele. O arquivo `.nvmrc` também foi incluído como alternativa para quem já utiliza nvm/fnm.

## Onde informar o número e o grupo (GP)

Tudo é configurado pelo painel, na opção **WhatsApp** do menu lateral.

### 1. Conectar o aparelho

1. No painel, abra **WhatsApp**.
2. Clique em **Conectar WhatsApp**.
3. Aguarde o QR Code aparecer.
4. No telefone que será usado pelo sistema, abra o WhatsApp.
5. Vá em **Configurações > Dispositivos conectados > Conectar dispositivo**.
6. Leia o QR Code mostrado no painel.

Quando aparecer **Aparelho conectado**, a sessão foi salva em `data/whatsapp-auth/`. Nos próximos reinícios, o sistema reutiliza esse vínculo automaticamente e não solicita outro QR. Quedas de rede, reinícios solicitados pelo WhatsApp e falhas temporárias entram em **Reconectando automaticamente**, com intervalo progressivo entre as tentativas; esses eventos não apagam as credenciais.

O botão **Desconectar temporariamente** encerra somente o socket do bot e preserva a sessão salva. **Trocar aparelho / novo QR** é a única ação do sistema que encerra o vínculo e apaga os arquivos locais. Até quando o WhatsApp recusa uma tentativa de sessão, as credenciais são mantidas para diagnóstico e nova tentativa; o sistema nunca as remove sozinho.

### 2. Informar o número

No campo **Número do WhatsApp**, informe somente números, incluindo DDI e DDD:

```text
5583999999999
```

Não use `+`, espaços, parênteses ou hífens. Este é o número de destino operacional configurado para o sistema; ele é armazenado no SQLite.

### 3. Escolher o grupo / GP

Depois que o aparelho estiver conectado, a lista **Grupo de destino** carrega os grupos dos quais ele participa. Basta escolher o grupo e salvar.

Se já tiver o identificador do grupo, cole-o em **ID do grupo (JID)**. O formato é:

```text
1203630XXXXXXXXXXX@g.us
```

O JID do grupo não é o nome visível do grupo. É o identificador técnico usado pelo WhatsApp. Preferencialmente escolha o grupo pela lista do painel; assim não é necessário procurar ou digitar o JID.

## Comandos do bot no WhatsApp

Depois de conectar o aparelho e selecionar o grupo, o militar só precisa estar cadastrado no **Efetivo** com o telefone. Envie estes comandos no grupo configurado:

| Mensagem | Ação |
|---|---|
| `/menu` ou `/ajuda` | Mostra os comandos do bot. |
| `/status` | Mostra situação e autorização do militar identificado pelo JID. |
| `/vagas` | Mostra a rodada no formato “dia e noite”, separando vagas normais e majoradas. |
| `/marcar 04; 05 noite` | Marca o dia 04 nos dois turnos e o dia 05 somente à noite. |
| `/marcar 24` | Informar somente o dia marca Dia e Noite, totalizando 24 horas. |
| Responder ao bot com `04; 05 noite` | Faz a mesma marcação usando uma resposta curta. |
| Responder ao bot com `extras para agosto 19 e 28, 24 horas` | Marca Dia e Noite nos dias 19 e 28. O mês citado é apenas texto de apoio. |
| Responder ao bot com `marcar 16 15 14, 24 horas` | Marca Dia e Noite nos três dias, mesmo com os dias separados apenas por espaços. |
| `/passo a vez` | Registra que o militar não deseja marcar na rodada aberta. |
| `/minhas` | Mostra as marcações futuras do próprio militar. |
| `/escala` | Envia a escala da competência ativa como PDF. |
| `/cancelar 125` | Cancela a própria marcação futura do horário `125`. |

O bot aceita quatro formas de interação:

1. Atalhos iniciados por `/`, como `/vagas` e `/minhas`.
2. Uma mensagem que marque o WhatsApp do bot, como `@Escala quero ver as vagas`.
3. Uma resposta direta a qualquer mensagem enviada pelo bot, como `quero 03 dia e noite e 05 noite`.
4. Uma resposta à mensagem de outro participante marcando o bot. Nesse caso, o sistema interpreta o conteúdo citado para o autor original. Exemplo: um militar envia `16 e 17` sem chamar o bot; outra pessoa responde àquela mensagem com `@Escala`, e o pedido é processado para o militar que escreveu `16 e 17`.

O encaminhamento por resposta não transfere permissões. O autor da mensagem original precisa estar cadastrado, ativo, autorizado e ser a pessoa que está na vez. O ID da resposta que chamou o bot é registrado para impedir que o mesmo evento do WhatsApp seja executado duas vezes.

Toda publicação da tabela de vagas — automática, pelo painel ou pelo comando `/vagas` — é seguida pelo PDF atualizado da escala. Nos envios automáticos e administrativos, o bot menciona o WhatsApp de quem está na vez; quando outro militar solicita `/vagas`, a consulta não gera uma nova menção.

Na linguagem natural, informar somente o número do dia significa **Dia e Noite (24 horas)**. Para escolher apenas um turno, escreva `05 dia` ou `05 noite`. O interpretador também aceita `28 dia e noite`, `28 dia noite`, vírgulas, ponto e vírgula e frases livres. Mensagens comuns do grupo que não tenham `/`, não marquem o bot e não sejam resposta a ele continuam completamente ignoradas.

Vagas **majoradas** são classificadas automaticamente em sextas, sábados, domingos e feriados nacionais, além dos feriados estaduais da Paraíba de 24/06 e 05/08. O militar pode usar a palavra `extras` normalmente: `extras 19 e 28, 24 horas`, `extras 19 dia e 28 noite` ou `quero 19 e 28 dia e noite`.

O bot funciona exclusivamente no grupo configurado no painel. Mensagens recebidas em conversas privadas são ignoradas antes da identificação do militar e nunca recebem resposta. Envios automáticos também exigem obrigatoriamente um JID de grupo terminado em `@g.us`.

O bot escolhe automaticamente a competência do próximo mês. Caso seja necessário abrir outra competência, o administrador pode gravar o ID desejado em `system_settings.bot_active_competency_id`; isso é a exceção administrativa, não é necessário no uso normal.

Na página **Horários**, o seletor mostra um mês por vez e abre, quando existir, no mês atual. A 1ª e a 2ª posições começam abertas em cada turno. A 3ª e a 4ª colunas permanecem visíveis no PDF em amarelo com `TRANCADA`; quando liberadas no painel, passam a valer para **Dia e Noite** nas datas escolhidas. No PDF, Dia e Sem. ficam mesclados entre os dois turnos da mesma data, sem uma linha horizontal no meio dessas células.

Quando todos os turnos abertos do mês alcançam dois confirmados, a automação libera a 3ª coluna para o mês inteiro, aumenta a capacidade de Dia e Noite para três, reinicia a fila pela Antiguidade, envia o cronograma e publica novamente vagas + PDF. A 4ª coluna permanece manual.

Toda abertura mensal e toda nova liberação manual de coluna publica um cronograma preenchido com a ordem e os horários definidos em **Antiguidade**. O cronograma mostra apenas `até HH:mm`, sem repetir as datas. O botão **Visão geral > Enviar cronograma** permite republicá-lo sem alterar a fila.

### Cadastro automático dos horários

Não é preciso cadastrar manualmente todos os horários de cada ano. Com **Configurações > Vagas do próximo mês > Enviar automaticamente** ativado, no dia e horário escolhidos (dia 25 por padrão) o sistema cria a competência do próximo mês e todos os seus turnos: um Diurno e um Noturno para cada dia. Essa rotina continua normalmente na virada do ano, desde que a API esteja ligada e o WhatsApp esteja conectado ao grupo.

O painel **Meses da escala** serve apenas para antecipar ou recuperar um mês manualmente: escolha ano e mês, clique em **Preparar mês**, e os turnos ausentes serão criados sem duplicar os que já existirem.

## Horas mensais

Cada vaga confirmada equivale a **12 horas**. Marcar Dia e Noite na mesma data soma **24 horas**. A página **Efetivo** permite selecionar a competência e exibe o total de cada militar no formato `horas usadas / limite mensal`. A marcação pelo bot é bloqueada antes de ultrapassar **192h** na competência; esse é o teto mensal do sistema.

No grupo, use `/horas @pessoa` (ou marque o bot e a pessoa escrevendo `horas`) para consultar as horas e todos os horários confirmados daquele militar no mês ativo.

Use `/cronograma` (ou marque o bot e escreva `cronograma`) para publicar a ordem completa da antiguidade, com o horário limite de cada militar. Assim que alguém marcar, o próximo pode marcar imediatamente, sem precisar esperar o horário final.

Para a **Base CICC**, a solicitação de 24 horas feita pelo militar que está na vez tem prioridade sobre uma marcação parcial de 12 horas somente quando o turno oposto da mesma coluna estiver vazio. O sistema pode retirar no máximo uma marcação parcial de outro militar da Base CICC e colocar o solicitante nos dois turnos, sempre na mesma posição do PDF. Se Dia e Noite já estiverem preenchidos por militares diferentes, nenhum deles será retirado. A operação sempre aumenta o preenchimento da tabela e é atômica: Dia e Noite são confirmados juntos ou nenhuma alteração é feita. Uma marcação que já ocupa 24 horas e marcações de militares de outra Base não são substituídas por essa regra.

Exemplo do fluxo que o militar verá:

```text
⏰ Sgt Fragoso.

Vagas normais:

03, 04, 10 e 13 — dia e noite.

Vagas majoradas:

05, 08 e 09 — dia e noite.

Prazo: até dia 27/07 às 09:00.

O Sr. pode responder assim:

“04; 05 noite”

Se não desejar marcar agora:

“PASSO A VEZ”.
```

O bot identifica primeiro os JIDs recebidos (`participant`, `participantAlt`/PN e LID). Quando encontra um número de telefone, procura o militar pelo campo **Telefone**, considerando também a variação brasileira com ou sem o nono dígito, salva automaticamente o JID telefônico no cadastro e registra também o LID na tabela de identidades. Ele não usa o nome visível do WhatsApp. Mensagens repetidas são ignoradas pelo ID original da mensagem.

Ao cadastrar ou editar um militar, basta informar o **Telefone**. Se o WhatsApp estiver conectado, o backend consulta o número no WhatsApp e salva o JID real encontrado. Se estiver desconectado ou ainda não encontrar, a consulta é repetida automaticamente quando o bot precisar marcar esse militar no grupo. O sistema não cria JID fictício a partir do telefone.

## Efetivo e status

Na página **Efetivo**, cada militar possui uma lista de situação na própria tabela:

O cadastro bloqueia outro militar com a mesma graduação e o mesmo nome operacional, ignorando diferenças entre letras maiúsculas e minúsculas. O botão **Excluir** remove somente cadastros sem escala nem histórico operacional; quando já há vínculos, o sistema preserva o histórico e orienta a alterar a situação para **Desativado**.

Em **Editar**, o campo **Limite mensal (horas)** define o teto individual entre 12h e 192h. Quando estiver vazio, o padrão é 192h. O mesmo limite aparece na tabela do Efetivo e é aplicado pelo bot antes de confirmar uma vaga de 12h ou uma marcação de 24h. Marque **Não contabilizar horas** para deixar o militar sem teto mensal: as marcações seguem registradas na escala, mas não consomem nem são bloqueadas pelo limite de horas.

| Situação mostrada | Valor interno | Efeito |
|---|---|---|
| Ativo | `ACTIVE` | Elegível, desde que autorizado. |
| Desativado | `INACTIVE` | Não entra nas marcações. |
| Férias | `VACATION` | Bloqueado para a escala no período. |
| Licença | `LEAVE` | Bloqueado para a escala no período. |
| Afastado | `AWAY` | Bloqueado para a escala no período. |

Clique em **Editar** na linha para alterar nome, graduação, telefone, JID, Base, autorização, situação e observação. Alterações não apagam o histórico do militar.

## Antiguidade

A página **Antiguidade** não altera nomes nem telefones. Ela altera apenas a posição de prioridade.

Use **Subir** e **Descer** na linha do militar. A nova ordem é salva imediatamente no banco, sem um segundo botão de confirmação. Os prazos acompanham as posições trocadas, mantendo a sequência cronológica, e a API grava uma versão completa da ordem no histórico de auditoria.

Ao editar uma data ou hora, o painel valida a sequência em tempo real. A linha incorreta fica destacada e a mensagem informa qual militar precisa ter o prazo ajustado e com qual militar ele está em conflito. A API repete a mesma validação antes de gravar, iniciar ou reiniciar a fila.

Ao clicar em **Encerrar e liberar para todos**, não existe militar na vez: o bot entra em **Marcação livre**. Nesse modo, qualquer militar ativo e autorizado pode marcar uma vaga disponível, sem bloqueio pela ordem de antiguidade. Iniciar ou reiniciar a fila volta a aplicar os prazos individuais.

Ao iniciar ou reiniciar por antiguidade, prazos que já venceram são ignorados automaticamente. O sistema abre a vez do primeiro militar cujo horário limite ainda é futuro e informa no painel quantos nomes anteriores foram pulados.

### Fila automática de marcação

Na página **Antiguidade**, organize apenas a ordem dos militares e clique em **Iniciar fila**. O primeiro militar apto é marcado no grupo e recebe a tabela completa de vagas.

Ao lado de cada militar, informe em **Antiguidade** a data e a hora limite daquela pessoa. Os limites devem seguir a ordem da antiguidade: quem está acima recebe o horário mais cedo.

Depois disso, a fila avança automaticamente pela ordem de antiguidade quando ocorre qualquer uma destas situações:

- o militar confirma pelo menos uma marcação;
- o militar envia `/passo a vez`;
- chega a data e hora limite cadastrada para ele.

O próximo militar apto é marcado no topo da nova tabela de vagas. Assim, uma confirmação antecipada libera imediatamente o próximo da lista, sem esperar o intervalo acabar. Não é enviado aviso separado de horário. A mensagem `/vagas` sempre informa quem está na vez. Depois do último militar, o bot anuncia o encerramento da rodada.

O botão **Reenviar tabela atual** publica novamente as vagas para a pessoa que está na vez sem avançar a fila. **Encerrar fila** fecha a sequência atual.

## Dados e segurança

- O token de sessão fica apenas em cookie `HttpOnly`; não é gravado no `localStorage`.
- Senhas são armazenadas com Argon2.
- A API exige autenticação e valida os dados com Zod.
- Alterações relevantes geram auditoria no SQLite.
- O banco usa foreign keys e WAL.
- A pasta de sessão do WhatsApp contém material sensível. Mantenha-a com permissão restrita e faça backup criptografado.
- Não envie spam, nem automatize mensagens fora das regras e dos termos aplicáveis ao WhatsApp.

## Estado atual da integração WhatsApp

O painel já conecta o WhatsApp por QR Code, persiste a sessão, mostra o número conectado e permite escolher/salvar o número e o grupo de destino. A camada de conexão está separada em `backend/src/messaging/whatsapp.js`; os próximos comportamentos de mensagens (rodadas, confirmação `OK`, cancelamentos e permutas) devem chamar essa camada sem criar uma segunda fonte de dados.

O conector utiliza Baileys, que se comunica com o WhatsApp Web por WebSocket e exige Node 20+. Consulte a [documentação oficial do Baileys](https://github.com/WhiskeySockets/Baileys) para detalhes do protocolo e das limitações da plataforma.

## Envios automáticos

Na página **Configurações**, o administrador configura as rotinas gerais:

- **Escala diária:** todos os dias, no horário escolhido, envia ao grupo a escala do dia seguinte separada em Dia (07h às 19h) e Noite (19h às 07h), mostrando os militares confirmados e as posições ainda vagas.
- **Abertura mensal:** no dia e horário escolhidos (por padrão, dia **25**), cria os horários que faltarem, envia o PDF completo e vazio do próximo mês, define essa competência como ativa e chama o primeiro militar apto da antiguidade.

Ao abrir um novo mês, a agenda individual da **Antiguidade** é renovada uma única vez: cada data limite avança um mês, preservando o dia e o horário de cada militar. A vez que ainda estiver aberta é encerrada e a nova rodada começa novamente pelo primeiro da lista.

As opções ficam em `system_settings`, incluindo a última execução diária e mensal. Isso impede duplicidade após reiniciar o servidor. Se o WhatsApp estiver desconectado no horário programado, o processo tenta novamente quando a conexão voltar. Na página **WhatsApp**, os botões **Enviar vagas agora**, **Enviar vagas do próximo mês** e **Enviar escala de amanhã** fazem envios manuais sem alterar o agendamento.

### Repetição da tabela de vagas

Em **Configurações**, configure **Repetir tabela de vagas** e o intervalo. Enquanto existir uma vez aberta, o bot republica a tabela completa de vagas e marca no topo quem deve responder. O padrão é 60 minutos e o mínimo é 5 minutos.

Quando o militar da vez confirma uma marcação ou responde `passo a vez`, o sistema avança imediatamente para o próximo e publica a mesma tabela marcando a nova pessoa. Não há aviso separado de horário. A data e hora individual cadastrada em **Antiguidade** só é usada para encerrar uma vez que venceu. O botão **Enviar vagas agora** permite reenviar a tabela atual sem trocar a pessoa.
