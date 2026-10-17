# Verificação Operacional — Criar e consultar Wallet

Status: Concluído e aprovado por Marcos em 2026-10-15.

Nota de escopo: a fase 06 de deploy não existe por enquanto. Este documento cobre somente verificação local, migration e rollback de banco; deploy de ambiente será definido futuramente.

## Pré-requisitos

- Bun 1.4.3 instalado.
- Docker Desktop em execução.
- PostgreSQL local gerenciado pelo Compose.
- Dependências instaladas com `bun install --frozen-lockfile`.

## Subir o banco

Na raiz do projeto:

```bash
docker compose up -d postgres
```

Verificar:

```bash
docker compose ps
```

O serviço `postgres` deve estar saudável na porta `5432`.

## Aplicar e reverter migration

Aplicar:

```bash
bun run migration:up
```

Reverter a última migration:

```bash
bun run migration:down
```

Reaplicar para confirmar reversibilidade:

```bash
bun run migration:up
```

A migration cria `wallets`, `wager_transactions`, `wallet_ledger_entries` e `mikro_orm_migrations`. O rollback remove os objetos na ordem reversa, incluindo trigger e função de imutabilidade.

## Verificações automatizadas

```bash
bun run typecheck
bun run build
bun run test
```

Evidência registrada nesta rodada: 27 testes passaram em 8 arquivos, incluindo unitários, HTTP, concorrência, atomicidade e proteção do ledger.

## Roteiro funcional

1. Enviar `POST /wallets` com `playerId` UUID, amount string e moeda ISO-4217.
2. Confirmar `201`, saldo serializado como string e `version = 1`.
3. Confirmar no banco uma wallet, um `OPENING` e um crédito quando o saldo for positivo.
4. Repetir com saldo `0.00` e confirmar ausência de `OPENING` e ledger.
5. Enviar `GET /wallets/:walletId` e confirmar `200`.
6. Consultar ID inexistente e confirmar `404`.
7. Repetir a criação no mesmo `(playerId, currency)` e confirmar `409`.
8. Disparar requisições concorrentes e confirmar no máximo uma criação.

## Regras de recuperação

- Não editar schema diretamente; criar uma nova migration reversível.
- Não apagar ou alterar lançamentos do ledger para corrigir dados.
- Em falha antes do commit, a transação deve fazer rollback integral.
- Em caso de falha de infraestrutura sem confirmação do commit, o endpoint retorna `503`; investigar a conexão e repetir de forma segura.
