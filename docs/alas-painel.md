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

Na página **Gestão do mês**, use **Gerar / regerar mês** ou **Regerar / escolher mês**. Na janela, escolha o mês e o ano exatos. O atalho **Próximo mês disponível** preenche o próximo mês sem impedir a escolha de outro período.

A prévia informa se é uma nova escala ou uma regeração, mostra a regra de ciclo válida para aquele mês e os dias das cinco alas. Também considera mudanças permanentes, remanejamentos temporários, férias, licença, afastamento, autorização e participação na ordinária.

Se o mês já foi gerado, os ordinários e suas observações manuais serão refeitos após a confirmação. Extras, tipos dos extras e a configuração das colunas são preservados. Serviços ordinários fechados ou homologados impedem a regeração completa até a revisão desses serviços.

Ao confirmar, somente o mês escolhido é processado. A tela abre esse mês e baixa o PDF. O mês ativo do WhatsApp permanece o configurado anteriormente. Se a execução falhar, a transação restaura os ordinários anteriores.

## Trocar ou remanejar um militar

Na página **Efetivo**, a coluna **Ala** tem um seletor com as alas 1 a 5, semelhante ao de Situação. Escolher uma ala abre uma confirmação, sem salvar imediatamente. A janela permite conferir a posição, trocar com outro militar e programar a mudança a partir do próximo mês. Também há a opção de aplicá-la às datas restantes da escala selecionada. Nesse caso, a mudança atual e a futura são salvas juntas; se houver conflito, nenhuma delas será salva. A tabela indica a mudança programada abaixo do seletor.

Antes da primeira mudança individual, faça o cadastro inicial em **Alas → Cadastrar militares nas alas**. Somente administradores e responsáveis pela escala podem alterar alas.

Clique em **Trocar / remanejar** ou use a tabela **Efetivo e mudanças programadas**.

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
