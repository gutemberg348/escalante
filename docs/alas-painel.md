# Alas no painel

A página **Alas** organiza os serviços ordinários em cinco alas, numeradas de 1 a 5, com duas posições por ala. A ala é uma equipe do ciclo; ela não é a coluna da escala.

## Primeiro cadastro

1. Abra **Alas** e selecione a escala que deve servir de referência.
2. Clique em **Cadastrar militares nas alas**.
3. Confira o aviso: as mudanças valerão a partir do mês seguinte ao selecionado, com a data de início indicada na tela.
4. Confira a ala e a posição de cada militar. No mês de referência, a Ala 1 corresponde aos dias 1, 6, 11…; a Ala 2 aos dias 2, 7, 12…; e assim até a Ala 5.
5. Se quiser atualizar também a escala selecionada, marque **Aplicar também nesta escala, nas datas que ainda não passaram** e escolha uma data de hoje em diante dentro desse mês. Essa opção vem desmarcada.
6. Confirme o cadastro.

São lidos apenas os serviços ordinários. Quem não tem ordinários no mês pode ser identificado pelo ciclo ordinário anterior, inclusive em férias. Casos com mais de um padrão são apresentados para conferência manual. Também é possível incluir militares manualmente na prévia.

Por padrão, esse cadastro preserva a escala existente e passa a orientar as gerações do próximo mês em diante. Se o próximo mês já estiver gerado, use **Regerar** nele para aplicar. A ala identificada na escala de referência fica como histórico desse mês; a ala escolhida na conferência passa a valer no seguinte.

Com a aplicação na escala selecionada habilitada, somente os ordinários dos militares cadastrados são recalculados a partir da data escolhida. Extras e datas anteriores são preservados. Conflitos com serviços ocupados, fechados ou homologados cancelam toda a operação, inclusive o cadastro futuro.

## Ciclo contínuo na virada do mês

O ciclo segue a data de referência e repete a cada cinco dias, incluindo a virada do mês. Não existe opção de reiniciar no dia 1. Se o último dia do mês for da Ala 3, o primeiro dia do mês seguinte será da Ala 4; depois seguem Ala 5, Ala 1, Ala 2 e Ala 3.

Gerar e regerar usam sempre essa sequência contínua. Meses já publicados não são reorganizados automaticamente: use **Gestão do mês → Regerar / escolher mês** para recalculá-los quando necessário.

## Gerar ou regerar um mês escolhido

Na página **Gestão do mês**, use **Gerar / regerar mês** ou **Regerar / escolher mês**. Na janela, escolha o mês e o ano exatos. O atalho **Próximo mês** preenche o mês seguinte ao atual no calendário, mesmo que já esteja gerado, sem impedir a escolha de outro período.

A prévia informa se é uma nova escala ou uma regeração, mostra a regra de ciclo válida para aquele mês e os dias das cinco alas. Também considera mudanças permanentes, remanejamentos temporários, férias, licença, afastamento, autorização e participação na ordinária.

Se o mês já foi gerado, os ordinários e suas observações manuais serão refeitos após a confirmação. Extras, tipos dos extras e a configuração das colunas são preservados. Serviços ordinários fechados ou homologados impedem a regeração completa até a revisão desses serviços.

Ao confirmar, somente o mês escolhido é processado. A tela abre esse mês e baixa o PDF. O mês ativo do WhatsApp permanece o configurado anteriormente. Se a execução falhar, a transação restaura os ordinários anteriores.

No WhatsApp, **@Escalante gerar próximo mês** também usa o próximo mês do calendário. Se ele já existir, o bot avisa que irá regerar os ordinários. O administrador responde **SIM** ou **NÃO** à pergunta curta. Regerar preserva extras e colunas; o pedido nunca pula para o mês seguinte só porque a escala já existe.

O PDF dessa geração ou regeneração é enviado somente no grupo em que o pedido foi confirmado. Os outros grupos podem consultar a mesma escala com **/escala** ou **@Escalante escala do próximo mês**, recebendo o PDF apenas no grupo que pediu.

Consultar **/escala próximo mês**, **/escala novembro** ou **/escala MM/AAAA**, assim como gerar/regerar um mês, mantém a seleção atual do WhatsApp. Para mudar explicitamente a seleção, um administrador configurado no painel usa **@Escalante escala zap mês que vem** ou **/escala zap MM/AAAA**. **/escala zap este mês** volta ao mês atual. Na virada do calendário, uma seleção antiga avança automaticamente para o mês gerado correspondente.

## Excluir um mês

Em **Gerenciar escala** ou **Gestão do mês**, selecione a competência e clique em **Excluir mês**. A confirmação mostra o nome do mês e a quantidade de ordinários e extras que serão removidos. Administradores e escalantes podem confirmar a exclusão.

A exclusão remove permanentemente o mês, seus horários, suas marcações e seus ajustes de colunas e alas temporárias. O cadastro dos militares, as alas permanentes, a sequência contínua e os outros meses são preservados. A operação fica registrada na auditoria com os dados removidos.

Se o mês excluído estava ativo no WhatsApp, a fila é encerrada e outro mês gerado é selecionado. Se não restar nenhum mês, a seleção fica vazia até uma nova geração. Falhas durante a exclusão desfazem toda a operação.

No celular, **Gerenciar escala** organiza as posições em cartões por data e turno, com botões maiores. **Retirar** abre uma confirmação com militar, dia, turno e posição; a retirada deixa apenas aquela posição vaga. A confirmação de retirada e a de exclusão do mês mantêm os botões visíveis, permitem rolar o conteúdo e mostram eventuais erros na própria janela.

### Observações nos serviços

Em **Gerenciar escala**, cada serviço ocupado possui o botão **Observação**, disponível para administradores e escalantes. Informe um texto livre, como `Sgt Jansen` para permuta, `ATESTADO`, `DISPENSADO` ou outra anotação. A prévia mostra o resultado: `Sgt Fragoso (Sgt Jansen)`. Os parênteses são automáticos; limite de 160 caracteres, em uma linha.

A observação vale somente para o militar, dia e turno selecionados. Não troca o militar nem altera coluna, tipo de serviço, protocolo ou horas. Funciona em ordinários e extras. Use **Limpar texto** e salve para remover a anotação existente. As anotações registradas pelo WhatsApp também podem ser editadas nessa janela.

O painel, a consulta de confirmados e os próximos PDFs usam a mesma anotação; o layout do PDF não muda. Horários fechados ou homologados bloqueiam a edição. Se a marcação tiver sido modificada após a abertura da janela, o servidor recusa a gravação e o painel recarrega a escala, evitando substituir uma alteração mais recente. A ação tem auditoria própria; o comando `/desfazer` do WhatsApp continua limitado às ações feitas pelo bot.

## Trocar ou remanejar um militar

Na página **Efetivo**, a coluna **Ala** tem um seletor com as alas 1 a 5, semelhante ao de Situação. Escolher uma ala abre uma confirmação, sem salvar imediatamente. A janela permite conferir a posição, trocar com outro militar e programar a mudança a partir do próximo mês. Também há a opção de aplicá-la às datas restantes da escala selecionada. Nesse caso, a mudança atual e a futura são salvas juntas; se houver conflito, nenhuma delas será salva. A tabela indica a mudança programada abaixo do seletor.

Antes da primeira mudança individual, faça o cadastro inicial em **Alas → Cadastrar militares nas alas**. Somente administradores e responsáveis pela escala podem alterar alas.

Clique em **Trocar / remanejar** ou use a tabela **Efetivo e mudanças programadas**.

As abas **Mês selecionado** e **Próximo mês** mostram os integrantes nas alas correspondentes. Depois de salvar uma mudança futura, a tela abre o próximo mês e mostra a nova ala e posição; inclusões e trocas recebem a indicação **Programada**. Quem já tem uma inclusão futura aparece com **Editar programação**, mesmo que ainda esteja sem ala no mês atual. Se o próximo mês já estiver gerado, é necessário regerá-lo para atualizar os serviços publicados.

No celular, a comparação entre meses e a conferência inicial usam cartões por militar. O menu principal abre lateralmente pelo botão no topo e fecha ao escolher uma página ou tocar fora.

- **Próximo mês em diante:** altera a ala permanente nas próximas gerações. O mês selecionado fica preservado. Se o próximo mês já foi gerado, use Regerar nesse mês.
- **Somente este mês:** escolha uma data, de hoje em diante, dentro da competência. Recalcula apenas os ordinários dos militares envolvidos a partir dessa data; o mês seguinte usa novamente a ala permanente.

Escolha a ala e a posição de destino. Para uma troca entre dois militares, selecione o outro participante em **Trocar com outro militar?**. A operação troca as duas alocações conjuntamente.

Se houver conflito com outro militar, um extra, uma posição fechada ou um serviço homologado, a operação é desfeita por inteiro e mostra o motivo. Não é feita exclusão de extras nem conversão de extra para ordinário. Férias, licença, afastamento, autorização e participação na ordinária continuam sendo respeitados.

Remanejamentos temporários ficam registrados com suas datas. Regerar o mês respeita os períodos desses remanejamentos.

## Atualização na VPS

Depois de enviar ou puxar todos os arquivos, na raiz do projeto:

```bash
npm ci
npm run build
pm2 restart escala-cicc-api
```

O servidor executa as migrações automaticamente ao iniciar. A `017_five_wing_planning` cria as estruturas das alas; a `018_continuous_wings_only` fixa o ciclo contínuo e unifica eventuais regras antigas pela referência inicial, sem reorganizar os serviços existentes. O primeiro cadastro pela escala é feito posteriormente, na página Alas.
