# Escala CICC

Sistema de escala de telefonistas, iniciado a partir do documento em `docs/projeto.md`.

## Requisitos

- Node.js 20 ou superior
- npm 10 ou superior

## Primeiro uso

1. Edite o arquivo `.env` e defina `SESSION_SECRET`, `ADMIN_EMAIL` e `ADMIN_INITIAL_PASSWORD`.
2. Execute `npm install`.
3. Execute `npm run seed` para criar o administrador, as cinco alas e o efetivo inicial.
4. Inicie o ambiente com `npm run dev`.
5. Abra `http://localhost:5173` e entre com o e-mail definido em `ADMIN_EMAIL`.

O banco SQLite fica em `data/escala.sqlite`. A infraestrutura e as credenciais iniciais são lidas exclusivamente do `.env`; elas não têm valores fixos em `env.js`. O seed não sobrescreve dados existentes.

## Entrega inicial

Esta base já inclui autenticação por cookie HttpOnly, perfis, auditoria, cadastro de efetivo, antiguidade versionada, competências, criação/listagem de horários e alteração auditável de capacidade. Os próximos módulos do documento (escala ordinária, rodadas, marcações, horas, homologações e mensagens) devem evoluir sobre essa base.

## WhatsApp e operação

O painel possui a página **WhatsApp** para gerar o QR Code, conectar o aparelho e selecionar o número e o grupo de destino. Veja o guia completo em [docs/arquitetura.md](docs/arquitetura.md).
