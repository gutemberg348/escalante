Projeto — Sistema de Escala dos Telefonistas do CICC

Instrução para o Codex

Desenvolva um sistema web completo, mas simples de manter, para organização das escalas dos telefonistas do CICC.

O sistema será utilizado por uma única unidade e deverá possuir:

• painel administrativo em React;
• backend em Node.js com Express;
• banco SQLite;
• identificação dos militares pelo número/JID do WhatsApp;
• cadastro e ordenação da antiguidade;
• cadastro das alas;
• escala ordinária no ciclo 1 por 4;
• criação e listagem dos horários de serviço;
• consulta das vagas disponíveis;
• controle da capacidade por data e período;
• marcação extraordinária por antiguidade;
• fase livre;
• controle mensal de horas;
• férias, licenças, afastamentos e retornos;
• cancelamentos e permutas;
• homologação das datas;
• histórico e auditoria.

Não transforme o projeto em uma arquitetura grande demais.

O objetivo é criar um sistema organizado, funcional e fácil de entender.

────────

1. Tecnologias

Frontend

Utilizar:

• React;
• Vite;
• JavaScript;
• React Router;
• Axios;
• React Hook Form;
• Zod;
• TanStack Query;
• Tailwind CSS ou CSS organizado.

Backend

Utilizar:

• Node.js 20 ou superior;
• Express;
• JavaScript com ESM;
• Zod;
• better-sqlite3;
• Day.js;
• node-cron;
• dotenv;
• pino;
• argon2;
• cookie-parser;
• helmet;
• cors;
• express-rate-limit.

Banco e execução

Utilizar:

• SQLite;
• prepared statements;
• transações;
• foreign keys;
• WAL mode;
• PM2;
• Nginx;
• HTTPS.

────────

2. Estrutura simples do projeto

```text
escala-cicc/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   ├── database/
│   │   ├── middlewares/
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── members/
│   │   │   ├── seniority/
│   │   │   ├── wings/
│   │   │   ├── unavailabilities/
│   │   │   ├── competencies/
│   │   │   ├── schedules/
│   │   │   ├── rounds/
│   │   │   ├── assignments/
│   │   │   ├── hours/
│   │   │   ├── requests/
│   │   │   ├── homologations/
│   │   │   ├── settings/
│   │   │   └── audit/
│   │   ├── messaging/
│   │   ├── scheduler/
│   │   ├── app.js
│   │   └── server.js
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── layouts/
│   │   ├── pages/
│   │   ├── routes/
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── package.json
│
├── data/
│   └── escala.sqlite
├── backups/
├── package.json
├── README.md
└── projeto.md
```

Cada módulo do backend pode possuir apenas:

```text
routes.js
controller.js
service.js
repository.js
schema.js
```

Não criar arquivos vazios ou abstrações sem necessidade.

────────

3. Fonte oficial dos dados

O SQLite será a fonte oficial das informações.

O WhatsApp será somente um canal de interação.

Os dados abaixo deverão ficar no banco:

• militares;
• nome operacional;
• telefone;
• JID;
• antiguidade;
• lotação;
• alas;
• competências;
• horários;
• vagas;
• marcações;
• férias;
• licenças;
• afastamentos;
• limites de horas;
• rodadas;
• cancelamentos;
• permutas;
• homologações;
• autorizações;
• histórico.

O sistema nunca deverá depender somente da memória da conversa ou do nome visível no WhatsApp.

────────

4. Identificação do militar

Cada militar terá três informações separadas.

ID interno

É criado pelo banco e nunca muda.

```text
member_id = 7
```

Nome operacional

É o nome exibido na escala e nas mensagens.

```text
Sgt Jomar
```

Telefone e JID

São utilizados para identificar quem enviou uma mensagem.

```text
phone_number = 5583999999999
whatsapp_jid = 5583999999999@s.whatsapp.net
```

O nome exibido pela pessoa no WhatsApp deve ser ignorado para identificação.

Fluxo:

```text
Mensagem recebida
    ↓
Extrair JID do remetente
    ↓
Buscar militar pelo JID
    ↓
Obter ID interno
    ↓
Obter nome operacional
    ↓
Obter posição na antiguidade
    ↓
Validar autorização e disponibilidade
    ↓
Processar solicitação
```

────────

5. Cadastro do efetivo

Cada militar deverá possuir:

• ID;
• graduação;
• nome operacional;
• nome completo restrito;
• telefone;
• JID do WhatsApp;
• posição na antiguidade;
• lotação;
• ala padrão;
• status operacional;
• status de autorização;
• perfil de acesso;
• ativo ou inativo;
• observação administrativa;
• data de cadastro;
• data da alteração.

Status operacional

```text
ACTIVE
VACATION
LEAVE
AWAY
INACTIVE
```

Status de autorização

```text
AUTHORIZED
PENDING
SUSPENDED
NOT_AUTHORIZED
```

Uma pessoa só será elegível quando:

```text
active = true
operational_status = ACTIVE
authorization_status = AUTHORIZED
```

Também deverá ser verificado se existe uma indisponibilidade ativa na data solicitada.

────────

6. Efetivo e antiguidade inicial

Cadastrar inicialmente nesta ordem:

1. Sub Ten G. Souza
2. Sgt Fragoso
3. Sgt Duarte
4. Sgt E. Silva
5. Sgt Jansen
6. Sgt Pedro Neto
7. Sgt Jomar
8. Sgt Santiago
9. Sgt Galdino
10. Cb Gelson
11. Sd Líssia

Lotação no CICC

• Sub Ten G. Souza;
• Sgt Fragoso;
• Sgt Duarte;
• Sgt E. Silva;
• Sgt Jansen;
• Sgt Pedro Neto;
• Sgt Jomar.

Apoio de outras unidades

• Sgt Santiago;
• Sgt Galdino;
• Cb Gelson;
• Sd Líssia.

A ordem completa já representa a prioridade.

Não criar uma segunda fila.

Pessoas pendentes

Cadastrar como não autorizados:

• Sd Samuel;
• Sd A. Costa.

Enquanto estiverem pendentes:

• não entram na fila;
• não podem marcar;
• não completam cobertura;
• não aparecem como disponíveis.

Histórico de nomes

Preservar os registros antigos:

• Cb Jomar;
• Cb Galdino.

Nas novas escalas usar:

• Sgt Jomar;
• Sgt Galdino.

────────

7. Painel de efetivo

Criar página:

```text
/efetivo
```

Exibir:

|Ordem|Nome operacional|Graduação|Telefone|JID|Lotação|Ala|Status|Autorização|
|----:|----------------|---------|--------|---|-------|---|------|-----------|

Permitir:

• cadastrar;
• editar;
• ativar;
• desativar;
• autorizar;
• suspender;
• alterar telefone;
• alterar JID;
• definir lotação;
• definir ala;
• visualizar histórico.

Não excluir fisicamente quem já possui histórico.

────────

8. Painel de antiguidade

Criar página:

```text
/antiguidade
```

Exibir uma lista numerada.

A posição deve apontar para o ID interno do militar.

Permitir reorganizar a ordem.

Antes de salvar:

1. mostrar a ordem anterior;
2. mostrar a nova ordem;
3. solicitar motivo;
4. solicitar confirmação;
5. criar uma nova versão;
6. registrar auditoria.

Alterar nome ou telefone não pode alterar a posição automaticamente.

────────

9. Usuários do painel

Criar perfis simples:

```text
ADMIN
SCHEDULER
APPROVING_AUTHORITY
SYSTEM_OPERATOR
```

ADMIN

Pode gerenciar tudo.

SCHEDULER

Pode:

• cadastrar efetivo;
• configurar escala;
• cadastrar indisponibilidades;
• abrir rodadas;
• revisar marcações;
• autorizar permutas;
• emitir relatórios.

APPROVING_AUTHORITY

Pode:

• aprovar escala;
• autorizar limite excepcional;
• autorizar aumento de capacidade;
• autorizar cancelamento crítico;
• homologar quando aplicável.

SYSTEM_OPERATOR

Pode:

• consultar escala aprovada;
• gerar relatório;
• confirmar lançamento;
• apontar divergências.

────────

10. Autenticação

Utilizar:

• login e senha;
• Argon2;
• cookie HttpOnly;
• expiração de sessão;
• rate limit;
• controle de perfil;
• auditoria de login.

Não armazenar token de autenticação no localStorage.

Rotas:

```http
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

────────

11. Competência mensal

Cada mês deve ser tratado como uma competência separada.

Exemplo:

```text
Competência: 2026-08
Estado: Em configuração
Limite de horas: 192
Capacidade normal por período: 3
```

Guardar:

• mês;
• ano;
• nome;
• estado;
• data de abertura;
• data da rodada;
• limite de horas;
• autorização excepcional;
• versão;
• observações.

Estados:

```text
CONFIGURING
DRAFT
OPEN
UNDER_REVIEW
APPROVED
PUBLISHED
CLOSED
CANCELLED
```

A homologação é controlada por data, e não somente pela competência inteira.

────────

12. Horários de serviço

Esta parte deverá ser simples e configurável pelo painel.

Os períodos padrão são:

```text
DIURNO = 07:00 até 19:00
NOTURNO = 19:00 até 07:00 do dia seguinte
```

Cada período representa 12 horas.

O painel deve permitir:

1. inserir um horário para uma data;
2. inserir os dois horários para uma data;
3. gerar os horários para um intervalo de datas;
4. listar todos os horários;
5. listar somente horários disponíveis;
6. filtrar por data;
7. filtrar por período;
8. filtrar por quantidade de vagas;
9. abrir ou fechar um horário;
10. alterar a capacidade autorizada.

Criar um único horário

Exemplo:

```text
Data: 05/08/2026
Período: Diurno
Início: 07:00
Fim: 19:00
Mínimo necessário: 2
Capacidade atual: 3
```

Criar um intervalo

Exemplo:

```text
De: 01/08/2026
Até: 31/08/2026
Criar:
[X] Diurno — 07:00 até 19:00
[X] Noturno — 19:00 até 07:00
```

O sistema deverá gerar os horários de todos os dias do intervalo.

Não criar duplicados.

Listagem

Criar página:

```text
/horarios
```

Exibir:

|Data|Dia|Período|Início|Fim|Confirmados|Mínimo|Capacidade|Livres|Estado|
|----|---|-------|------|---|----------:|-----:|---------:|-----:|------|

Filtros:

• competência;
• data inicial;
• data final;
• período;
• disponíveis;
• lotados;
• abaixo do mínimo;
• homologados;
• majorados.

────────

13. Cobertura mínima e capacidade

Cada horário deverá possuir:

```text
minimum_required = 2
normal_capacity = 3
current_capacity = 3
```

Regra normal

• no mínimo 2 pessoas;
• normalmente até 3 pessoas;
• capacidade padrão igual a 3.

Cobertura

Exemplos:

```text
0/2 = sem cobertura
1/2 = cobertura incompleta
2/2 = cobertura mínima completa
3/3 = capacidade normal completa
```

A quarta pessoa ou qualquer capacidade acima de 3 só poderá ser utilizada quando a capacidade vigente tiver sido aumentada no painel.

────────

14. Aumento de capacidade pelo painel

O painel deverá permitir aumentar a capacidade de um ou vários horários.

Criar uma ação:

```text
ALTERAR CAPACIDADE
```

O usuário poderá aplicar a alteração em:

1. somente um horário;
2. os dois períodos de uma data;
3. várias datas selecionadas;
4. um intervalo de datas;
5. somente diurno no intervalo;
6. somente noturno no intervalo;
7. ambos os períodos no intervalo.

Exemplo:

```text
Aplicar de: 10/08/2026
Até: 15/08/2026
Períodos:
[X] Diurno
[X] Noturno

Capacidade atual: 3
Nova capacidade: 4
```

Antes de salvar, exigir:

• motivo;
• autoridade responsável;
• referência da autorização;
• data e hora da autorização;
• confirmação do operador.

Guardar o histórico da capacidade anterior.

Redução de capacidade

Também permitir voltar de 4 para 3, desde que:

• não existam quatro pessoas confirmadas;
• a data não esteja homologada;
• a redução não deixe marcações fora da capacidade.

Se existirem mais marcações que o novo limite, bloquear a redução e explicar o motivo.

────────

15. Disponibilidade dos horários

Um horário está disponível quando:

```text
status = OPEN
confirmed_count < current_capacity
data não homologada
```

Criar endpoint e tela para listar somente horários disponíveis.

A resposta deverá mostrar:

• data;
• dia da semana;
• período;
• início;
• fim;
• quantidade confirmada;
• capacidade vigente;
• vagas livres;
• majorado ou normal;
• prazo de homologação.

Exemplo:

```text
05/08/2026 — Diurno
07:00 às 19:00
Confirmados: 2
Capacidade: 3
Vagas livres: 1
Tipo: Extraordinário
```

────────

16. Posições do horário

Internamente, cada horário terá posições numeradas.

Exemplo com capacidade 3:

```text
Posição 1
Posição 2
Posição 3
```

Uso:

• posição 1: normalmente ordinário;
• posição 2: completar cobertura mínima;
• posição 3: vaga adicional normal;
• posição 4 ou superior: somente quando capacidade aumentada.

O painel poderá mostrar colunas visualmente, mas a implementação deve usar posições simples.

Isso evita uma estrutura complicada sem perder a regra operacional.

────────

17. Escala ordinária 1 por 4

O ciclo ordinário é:

```text
1 dia de serviço por 4 dias de folga
```

O ciclo total é de cinco dias.

Existem cinco alas.

O sistema deverá:

1. cadastrar as cinco alas;
2. cadastrar a data-base de cada ala;
3. associar militares;
4. gerar o mês;
5. continuar o ciclo entre meses;
6. aplicar indisponibilidades;
7. identificar horários abaixo do mínimo;
8. gerar rascunho;
9. solicitar aprovação.

────────

18. Alas

Criar página:

```text
/alas
```

Cada ala deve guardar:

• nome;
• código;
• data-base;
• integrantes padrão;
• integrantes aplicados na competência;
• motivo de ajuste;
• período de validade;
• aprovação.

Separar:

```text
ala padrão
```

de:

```text
ala aplicada no mês
```

Um ajuste mensal não altera automaticamente a ala permanente.

────────

19. Retorno de férias, licença ou afastamento

Quando alguém retornar:

1. verificar quem está saindo;
2. identificar ala vazia ou com apenas uma pessoa;
3. sugerir encaixe;
4. preservar o ciclo;
5. mostrar impacto;
6. solicitar aprovação;
7. registrar o motivo;
8. aplicar somente na competência;
9. preservar a ala padrão.

Exemplo confirmado:

```text
Sgt Jansen estava de férias em julho de 2026.
```

A composição excepcional de julho não deverá ser repetida automaticamente.

────────

20. Indisponibilidades

Criar página:

```text
/indisponibilidades
```

Registrar:

• militar;
• tipo;
• início;
• fim;
• afeta ordinário;
• afeta extraordinário;
• referência;
• usuário responsável;
• estado.

Tipos:

```text
VACATION
LEAVE
AWAY
OTHER
RETURN
```

Não registrar diagnóstico médico.

Antes de aplicar uma indisponibilidade, mostrar o impacto na escala.

────────

21. Marcação extraordinária

A prioridade inicial é completar os horários que possuem somente uma pessoa.

Ordem de preenchimento:

1. completar o mínimo de dois;
2. depois utilizar a terceira posição;
3. somente utilizar a quarta posição ou superior quando a capacidade estiver aumentada.

Ao abrir uma nova posição de preenchimento, iniciar uma nova rodada pela antiguidade.

────────

22. Rodada por antiguidade

Cronograma padrão:

1. Sub Ten G. Souza — até 08:00
2. Sgt Fragoso — até 09:00
3. Sgt Duarte — até 10:00
4. Sgt E. Silva — até 11:00
5. Sgt Jansen — até 12:00
6. Sgt Pedro Neto — até 13:00
7. Sgt Jomar — até 14:00
8. Sgt Santiago — até 15:00
9. Sgt Galdino — até 16:00
10. Cb Gelson — até 17:00
11. Sd Líssia — até 18:00

A rodada normalmente começa às 07:00.

────────

23. Liberação antecipada

Quando o militar atual:

• concluir a marcação;
• responder PASSAR VEZ;
• recusar formalmente;

o próximo deverá ser liberado imediatamente.

O prazo final original do próximo permanece igual.

Exemplo:

```text
Sub Ten conclui às 07:30.
Sgt Fragoso é liberado às 07:30.
O prazo de Sgt Fragoso continua até 09:00.
```

Guardar:

• início previsto;
• prazo original;
• horário de liberação;
• horário de conclusão;
• motivo.

────────

24. Várias marcações na mesma vez

Durante a própria janela, cada militar poderá escolher vários horários.

Exemplo:

```text
MARCAR 05/08 07-19, 06/08 19-07, 08/08 07-19
```

O sistema deverá:

1. separar os itens;
2. validar cada item;
3. aceitar os disponíveis;
4. rejeitar somente os inválidos;
5. mostrar resultado parcial;
6. reservar temporariamente;
7. solicitar um único OK;
8. confirmar tudo em transação.

Não limitar o militar a uma única marcação.

────────

25. Confirmação por OK

Depois da seleção, mostrar:

```text
⚠️ CONFIRME SUA SOLICITAÇÃO

Disponíveis:
- 05/08 — 07:00 às 19:00
- 08/08 — 19:00 às 07:00

Não disponível:
- 06/08 — 07:00 às 19:00

Total de horas a confirmar: 24h
Saldo após confirmação: 84h

Responda somente OK.
```

Aceitar somente a mensagem exata:

```text
OK
```

Permitir cancelar com:

```text
CANCELAR
```

Antes de gravar, revalidar:

• vaga;
• capacidade;
• homologação;
• limite de horas;
• elegibilidade;
• indisponibilidade;
• duplicidade;
• rodada;
• posição aberta.

────────

26. Fase livre

Depois das 18:00:

• encerra a prioridade por antiguidade;
• todos os elegíveis podem marcar;
• inclui quem marcou;
• inclui quem passou;
• inclui quem não respondeu;
• vale a ordem registrada pelo servidor.

Não criar uma segunda fila de atrasados.

Estados da rodada:

```text
SENIORITY
FREE
COMPLETED
PAUSED
CANCELLED
```

────────

27. Limite mensal de horas

Cada período soma 12 horas.

Dois períodos somam 24 horas.

Limite padrão

```text
192 horas
```

Limite excepcional

```text
240 horas
```

A ampliação para 240 horas:

• vale somente para a competência;
• precisa ser autorizada pelo Coronel Edenio;
• pode ser registrada antes ou durante o mês;
• não passa automaticamente para o mês seguinte.

O serviço ordinário não entra nesse limite.

Somar:

• extraordinário;
• majorado.

Fórmula:

```text
saldo = limite vigente - horas comprometidas
```

────────

28. Tela de controle de horas

Criar página:

```text
/horas
```

Exibir:

|Militar|Extra|Majorado|Comprometido|Realizado|Limite|Saldo|
|-------|----:|-------:|-----------:|--------:|-----:|----:|

Mostrar alertas quando:

• atingir 80%;
• estiver próximo do limite;
• atingir o limite;
• houver autorização de 240 horas.

────────

29. Majorados

Classificar como majorado:

• sexta-feira;
• sábado;
• domingo;
• feriado nacional;
• feriado estadual da Paraíba.

O sistema não calcula valores financeiros.

Exibir somente a classificação.

Guardar regras configuráveis para:

• sexta-feira inteira ou parcial;
• noturno atravessando duas datas;
• feriado dentro do período;
• ponto facultativo;
• feriado municipal.

Não aplicar regra pendente sem configuração.

────────

30. Feriados

Criar página:

```text
/feriados
```

Campos:

• data;
• nome;
• tipo;
• esfera;
• dia não útil;
• majorado;
• fonte;
• conferido por;
• data de conferência.

Tipos:

```text
NATIONAL
STATE_PB
MUNICIPAL
OPTIONAL
INSTITUTIONAL
```

────────

31. Cancelamentos

Cancelamento normal

Se depois do cancelamento permanecerem pelo menos duas pessoas:

• aprovar;
• devolver horas;
• liberar a vaga;
• deixar disponível para todos;
• registrar histórico.

Cancelamento crítico

Se o horário ficar com apenas uma pessoa:

• manter a marcação;
• manter as horas comprometidas;
• não abrir a vaga;
• aguardar autorização do Coronel Edenio;
• concluir antes da homologação.

Quando aprovado:

• cancelar;
• devolver horas;
• abrir a vaga;
• primeira solicitação válida vence.

────────

32. Permutas

Uma permuta exige:

1. solicitação;
2. concordância do original;
3. concordância do substituto;
4. validação de disponibilidade;
5. validação de horas;
6. autorização do escalante;
7. conclusão antes da homologação.

Enquanto estiver pendente, o original continua responsável.

Depois da aprovação, exibir:

```text
Nome A (Nome B)
```

Onde:

```text
Nome A = escalado original
Nome B = quem efetivamente assumiu
```

────────

33. Homologação

Cada data será homologada:

```text
12:00 do dia útil imediatamente anterior
```

Exemplos:

• terça comum: segunda às 12:00;
• sábado: sexta às 12:00;
• domingo: sexta às 12:00;
• segunda: sexta às 12:00;
• terça após segunda feriado: sexta anterior às 12:00.

Na sexta-feira, homologar normalmente:

• sábado;
• domingo;
• segunda.

Quando segunda for feriado, incluir terça.

Depois da homologação:

• não marcar;
• não cancelar;
• não permutar;
• não corrigir;
• não aumentar ou reduzir capacidade;
• não reabrir vaga;
• não concluir solicitações pendentes.

Estado da data:

```text
HOMOLOGATED_IMMUTABLE
```

────────

34. Painel da escala

Criar página:

```text
/escala
```

Exibir por data:

|Data|Período|Posição 1|Posição 2|Posição 3|Extras autorizadas|
|----|-------|---------|---------|---------|------------------|

Regras visuais:

• ordinário: preto;
• extraordinário: vermelho;
• majorado: etiqueta;
• permuta: parênteses;
• horário fechado: amarelo;
• homologado: cinza;
• cobertura incompleta: alerta.

Não depender somente da cor.

────────

35. Dashboard

Criar página:

```text
/dashboard
```

Mostrar somente informações úteis:

• competência atual;
• horários cadastrados;
• horários disponíveis;
• horários abaixo do mínimo;
• horários lotados;
• rodada atual;
• pessoa atual;
• prazo;
• horas próximas do limite;
• cancelamentos pendentes;
• permutas pendentes;
• próximas homologações.

Evitar excesso de cards e informações secundárias.

────────

36. Tela de configurações

Criar página:

```text
/configuracoes
```

Permitir configurar:

• nome da unidade;
• fuso horário;
• nome do grupo;
• JID do grupo;
• modo de operação;
• horários padrão;
• mínimo padrão;
• capacidade normal;
• limite mensal;
• tempo de confirmação;
• horários das mensagens;
• regras de majorado.

Dados operacionais devem ficar no banco.

O .env fica apenas para infraestrutura.

────────

37. Modos de comunicação

MANUAL

O sistema gera a mensagem para o escalante copiar.

SIMULATION

O sistema executa o fluxo sem enviar mensagens reais.

AUTOMATIC

O sistema envia pelo provedor configurado.

O motor da escala deve funcionar nos três modos.

────────

38. Integração de mensagens

Criar uma camada simples:

```text
messaging/
├── manual.provider.js
├── simulation.provider.js
└── whatsapp.provider.js
```

Funções básicas:

```js
sendGroupMessage()
sendDirectMessage()
getConnectionStatus()
```

O restante do sistema não deve depender diretamente da biblioteca do WhatsApp.

────────

39. Banco de dados

Criar migrations para as tabelas abaixo.

users

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

members

```sql
CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rank TEXT NOT NULL,
    operational_name TEXT NOT NULL,
    full_name TEXT,
    phone_number TEXT UNIQUE,
    whatsapp_jid TEXT UNIQUE,
    seniority_position INTEGER UNIQUE,
    unit_type TEXT NOT NULL,
    default_wing_id INTEGER,
    operational_status TEXT NOT NULL DEFAULT 'ACTIVE',
    authorization_status TEXT NOT NULL DEFAULT 'AUTHORIZED',
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

member_history

```sql
CREATE TABLE member_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by INTEGER NOT NULL,
    reason TEXT,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
);
```

seniority_versions

```sql
CREATE TABLE seniority_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL UNIQUE,
    order_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
);
```

wings

```sql
CREATE TABLE wings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

competencies

```sql
CREATE TABLE competencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CONFIGURING',
    standard_hour_limit INTEGER NOT NULL DEFAULT 192,
    current_hour_limit INTEGER NOT NULL DEFAULT 192,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(year, month)
);
```

competency_wings

```sql
CREATE TABLE competency_wings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competency_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    wing_id INTEGER NOT NULL,
    adjustment_reason TEXT,
    approved_by INTEGER,
    approved_at TEXT,
    FOREIGN KEY (competency_id) REFERENCES competencies(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (wing_id) REFERENCES wings(id),
    FOREIGN KEY (approved_by) REFERENCES users(id),
    UNIQUE(competency_id, member_id)
);
```

unavailabilities

```sql
CREATE TABLE unavailabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    affects_ordinary INTEGER NOT NULL DEFAULT 1,
    affects_extraordinary INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    reference TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);
```

holidays

```sql
CREATE TABLE holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    is_non_working_day INTEGER NOT NULL DEFAULT 1,
    is_majorado INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

service_slots

Tabela principal dos horários.

```sql
CREATE TABLE service_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competency_id INTEGER NOT NULL,
    service_date TEXT NOT NULL,
    period TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    minimum_required INTEGER NOT NULL DEFAULT 2,
    normal_capacity INTEGER NOT NULL DEFAULT 3,
    current_capacity INTEGER NOT NULL DEFAULT 3,
    service_classification TEXT NOT NULL DEFAULT 'EXTRAORDINARY',
    is_majorado INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN',
    homologation_deadline TEXT NOT NULL,
    homologated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (competency_id) REFERENCES competencies(id),
    UNIQUE(competency_id, service_date, period)
);
```

capacity_changes

```sql
CREATE TABLE capacity_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_slot_id INTEGER NOT NULL,
    previous_capacity INTEGER NOT NULL,
    new_capacity INTEGER NOT NULL,
    authority_name TEXT NOT NULL,
    authorization_reference TEXT NOT NULL,
    reason TEXT NOT NULL,
    changed_by INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (service_slot_id) REFERENCES service_slots(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
);
```

assignments

```sql
CREATE TABLE assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_slot_id INTEGER NOT NULL,
    position_number INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    original_member_id INTEGER,
    service_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    protocol TEXT NOT NULL UNIQUE,
    source_message_id TEXT,
    confirmed_at TEXT NOT NULL,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (service_slot_id) REFERENCES service_slots(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (original_member_id) REFERENCES members(id),
    UNIQUE(service_slot_id, position_number)
);
```

rounds

```sql
CREATE TABLE rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competency_id INTEGER NOT NULL,
    position_number INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'SENIORITY',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    scheduled_start TEXT NOT NULL,
    free_phase_start TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (competency_id) REFERENCES competencies(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);
```

round_windows

```sql
CREATE TABLE round_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    scheduled_start TEXT NOT NULL,
    original_deadline TEXT NOT NULL,
    released_at TEXT,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'WAITING',
    release_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (round_id) REFERENCES rounds(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    UNIQUE(round_id, member_id)
);
```

selection_requests

```sql
CREATE TABLE selection_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    source_message_id TEXT UNIQUE,
    items_json TEXT NOT NULL,
    protocol TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    confirmed_at TEXT,
    FOREIGN KEY (round_id) REFERENCES rounds(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
);
```

monthly_hours

```sql
CREATE TABLE monthly_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competency_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    hour_limit INTEGER NOT NULL DEFAULT 192,
    committed_hours INTEGER NOT NULL DEFAULT 0,
    completed_hours INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (competency_id) REFERENCES competencies(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    UNIQUE(competency_id, member_id)
);
```

authorizations

```sql
CREATE TABLE authorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competency_id INTEGER,
    type TEXT NOT NULL,
    authority_name TEXT NOT NULL,
    reference TEXT NOT NULL,
    payload_json TEXT,
    authorized_at TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (competency_id) REFERENCES competencies(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);
```

change_requests

Tabela simples para cancelamentos e permutas.

```sql
CREATE TABLE change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL,
    request_type TEXT NOT NULL,
    requested_by_member_id INTEGER NOT NULL,
    substitute_member_id INTEGER,
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    requires_colonel_authorization INTEGER NOT NULL DEFAULT 0,
    protocol TEXT NOT NULL UNIQUE,
    payload_json TEXT,
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by INTEGER,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id),
    FOREIGN KEY (requested_by_member_id) REFERENCES members(id),
    FOREIGN KEY (substitute_member_id) REFERENCES members(id),
    FOREIGN KEY (decided_by) REFERENCES users(id)
);
```

audit_logs

```sql
CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    member_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
);
```

processed_messages

```sql
CREATE TABLE processed_messages (
    message_id TEXT PRIMARY KEY,
    sender_jid TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT NOT NULL
);
```

system_settings

```sql
CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id)
);
```

────────

40. Rotas principais da API

Efetivo

```http
GET    /api/members
POST   /api/members
GET    /api/members/:id
PATCH  /api/members/:id
POST   /api/members/:id/authorize
POST   /api/members/:id/suspend
```

Antiguidade

```http
GET /api/seniority
PUT /api/seniority
GET /api/seniority/versions
```

Alas e indisponibilidades

```http
GET  /api/wings
POST /api/wings
PUT  /api/competencies/:id/wings

GET  /api/unavailabilities
POST /api/unavailabilities
PATCH /api/unavailabilities/:id
```

Competências

```http
GET  /api/competencies
POST /api/competencies
GET  /api/competencies/:id
POST /api/competencies/:id/generate-ordinary
```

Horários

```http
GET    /api/service-slots
POST   /api/service-slots
POST   /api/service-slots/generate-range
PATCH  /api/service-slots/:id
POST   /api/service-slots/:id/open
POST   /api/service-slots/:id/close
GET    /api/service-slots/available
POST   /api/service-slots/capacity/bulk-update
```

Rodadas

```http
POST /api/rounds
GET  /api/rounds/:id
POST /api/rounds/:id/start
POST /api/rounds/:id/pause
POST /api/rounds/:id/resume
POST /api/rounds/:id/pass-current
POST /api/rounds/:id/open-free-phase
POST /api/rounds/:id/complete
```

Marcações

```http
POST /api/selections
POST /api/selections/:id/confirm
POST /api/selections/:id/cancel
GET  /api/members/:id/assignments
```

Horas e alterações

```http
GET  /api/competencies/:id/hours
POST /api/competencies/:id/hour-limit

POST /api/change-requests
POST /api/change-requests/:id/approve
POST /api/change-requests/:id/reject
```

Homologação e auditoria

```http
GET  /api/homologations
POST /api/homologations/run
GET  /api/audit
```

────────

41. Páginas do React

Criar:

```text
/login
/dashboard
/efetivo
/antiguidade
/alas
/indisponibilidades
/competencias
/horarios
/escala
/rodadas
/horas
/pendencias
/feriados
/homologacoes
/auditoria
/configuracoes
```

────────

42. Componentes principais

Criar somente componentes úteis:

```text
AppLayout
Sidebar
ProtectedRoute
DataTable
StatusBadge
ConfirmDialog
MemberForm
SeniorityEditor
WingForm
UnavailabilityForm
CompetencyForm
ServiceSlotForm
ServiceSlotRangeForm
CapacityChangeDialog
AvailableSlotsTable
ScheduleGrid
RoundPanel
HourBalanceTable
PendingRequestsTable
MessagePreview
```

────────

43. Validação e segurança

Todas as entradas devem ser validadas no backend com Zod.

Utilizar:

• prepared statements;
• transações;
• Helmet;
• CORS restrito;
• cookie HttpOnly;
• rate limit;
• perfis;
• auditoria;
• HTTPS;
• backup;
• validação de capacidade;
• validação de data homologada;
• validação de JID;
• proteção contra mensagens duplicadas.

────────

44. Transações obrigatórias

Utilizar transações para:

• confirmar uma ou várias marcações;
• ocupar a última vaga;
• alterar capacidade de vários horários;
• alterar o limite mensal;
• cancelar;
• concluir permuta;
• homologar datas;
• reordenar antiguidade.

────────

45. .env

Usar apenas para infraestrutura:

```env
NODE_ENV=development
API_PORT=3000
WEB_URL=http://localhost:5173
DATABASE_PATH=./data/escala.sqlite
TIMEZONE=America/Fortaleza
SESSION_SECRET=
LOG_LEVEL=info
BACKUP_PATH=./backups
```

Dados como grupo, horários, capacidades, telefones, JIDs e antiguidade devem ficar no banco.

────────

46. Configurações iniciais

Criar no banco:

```text
timezone = America/Fortaleza
default_day_start = 07:00
default_day_end = 19:00
default_night_start = 19:00
default_night_end = 07:00
default_minimum_required = 2
default_normal_capacity = 3
default_hour_limit = 192
confirmation_timeout_minutes = 3
operation_mode = SIMULATION
```

────────

47. Dashboard inicial

O dashboard deve responder rapidamente:

• quantos horários foram criados;
• quantos ainda possuem vaga;
• quantos estão abaixo do mínimo;
• quantos estão lotados;
• qual é a rodada atual;
• quem está na vez;
• quais datas serão homologadas;
• quem está próximo do limite;
• quais pedidos estão pendentes.

────────

48. Testes mínimos

Testar:

• identificação por JID;
• nome do WhatsApp ignorado;
• reordenação da antiguidade;
• criação de um horário;
• criação de intervalo;
• prevenção de duplicidade;
• listagem de horários disponíveis;
• mínimo igual a 2;
• capacidade normal igual a 3;
• aumento para 4 em um dia;
• aumento para 4 em intervalo;
• redução de capacidade inválida;
• marcação múltipla;
• confirmação por OK;
• concorrência pela última vaga;
• limite 192h;
• alteração para 240h;
• dois períodos consecutivos;
• bloqueio de militar pendente;
• fase livre;
• cancelamento;
• permuta;
• homologação;
• classificação majorada.

────────

49. Dados iniciais

Criar seed com:

Usuário administrador

Criar usuário inicial por script, exigindo troca de senha no primeiro login.

Alas

• Ala 1;
• Ala 2;
• Ala 3;
• Ala 4;
• Ala 5.

Efetivo autorizado

• Sub Ten G. Souza;
• Sgt Fragoso;
• Sgt Duarte;
• Sgt E. Silva;
• Sgt Jansen;
• Sgt Pedro Neto;
• Sgt Jomar;
• Sgt Santiago;
• Sgt Galdino;
• Cb Gelson;
• Sd Líssia.

Efetivo pendente

• Sd Samuel;
• Sd A. Costa.

Os telefones e JIDs serão inseridos pelo painel.

────────

50. Ordem de implementação

Implementar nesta ordem:

1. backend Express;
2. banco e migrations;
3. autenticação;
4. cadastro do efetivo;
5. antiguidade;
6. competências;
7. horários;
8. alteração de capacidade;
9. listagem de disponíveis;
10. escala ordinária;
11. alas e indisponibilidades;
12. rodadas;
13. marcações;
14. horas;
15. cancelamentos e permutas;
16. homologação;
17. auditoria;
18. frontend React;
19. dashboard;
20. testes;
21. README;
22. modo de mensagens.

────────

51. Critérios de aceite

O projeto estará concluído quando:

1. o painel abrir no computador e celular;
2. login funcionar;
3. cadastro do efetivo funcionar;
4. telefone e JID forem configuráveis;
5. o nome do WhatsApp não for usado como identidade;
6. a antiguidade puder ser reordenada;
7. o sistema criar um horário;
8. o sistema criar horários por intervalo;
9. os horários puderem ser listados;
10. os horários disponíveis puderem ser filtrados;
11. o mínimo padrão for 2;
12. a capacidade normal for 3;
13. o painel permitir aumentar a capacidade de um horário;
14. o painel permitir aumentar a capacidade de vários dias;
15. toda alteração de capacidade tiver histórico;
16. a escala ordinária 1 por 4 funcionar;
17. a rodada por antiguidade funcionar;
18. a liberação antecipada preservar o prazo;
19. a fase livre funcionar;
20. várias marcações serem processadas;
21. a confirmação por OK funcionar;
22. o controle de 192/240 horas funcionar;
23. cancelamento e permuta funcionarem;
24. a homologação bloquear alterações;
25. a auditoria registrar mudanças;
26. o SQLite permanecer como fonte oficial;
27. não existirem funções ou módulos sem necessidade;
28. o README explicar instalação e uso.

────────

52. Resultado esperado

O sistema deverá permitir que o escalante:

1. cadastre os militares;
2. configure telefone e JID;
3. organize a antiguidade;
4. registre bloqueios e indisponibilidades;
5. crie a competência;
6. insira horários de um dia;
7. gere horários para vários dias;
8. liste todos os horários;
9. visualize somente os disponíveis;
10. mantenha mínimo de dois;
11. trabalhe normalmente com até três;
12. aumente a capacidade de um dia ou intervalo quando autorizado;
13. acompanhe a escala;
14. abra a rodada;
15. confirme marcações;
16. controle horas;
17. homologue as datas;
18. consulte o histórico.

Desenvolva o projeto completo seguindo este documento, mantendo o código direto, organizado e fácil de manter.