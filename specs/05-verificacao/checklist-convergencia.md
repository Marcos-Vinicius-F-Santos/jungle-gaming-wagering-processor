# Checklist de Convergência — Criar e consultar Wallet

Status: Concluído e aprovado em 2026-10-15.

Documentos comparados:

- Spec da feature: [`../03-features/01-criar-consultar-wallet/spec.md`](../03-features/01-criar-consultar-wallet/spec.md)
- Plano: [`../04-plano/01-criar-consultar-wallet/plano.md`](../04-plano/01-criar-consultar-wallet/plano.md)
- Tarefas: [`../04-plano/01-criar-consultar-wallet/tarefas.md`](../04-plano/01-criar-consultar-wallet/tarefas.md)
- Arquitetura: [`../02-arquitetura/arquitetura.md`](../02-arquitetura/arquitetura.md)

## Requisitos e evidências

| Área | Evidência | Resultado |
|---|---|---|
| Bootstrap | `package.json`, `src/app.module.ts`, Bun 1.4.3, NestJS e MikroORM fixados | Conforme |
| Money | `src/shared/domain/money.ts`, `test/unit/money.test.ts` | Conforme |
| Wallet | `src/modules/wallets/domain/wallet.ts`, `test/unit/wallet.test.ts` | Conforme |
| OPENING e ledger | `src/modules/wagering/domain/wager-transaction.ts`, `src/modules/wallets/domain/wallet-ledger-entry.ts` | Conforme |
| Persistência | `Migration20261015190000.ts` e entidades MikroORM | Conforme |
| Atomicidade | `test/integration/database.atomicity.test.ts` | Conforme |
| Criação | `CreateWalletUseCase`, `POST /wallets` | Conforme |
| Consulta | `GetWalletUseCase`, `GET /wallets/:walletId` | Conforme |
| Validação | DTO, validator ISO-4217, testes unitários/HTTP | Conforme |
| Concorrência | `test/integration/wallets.http.test.ts`, 10 requisições simultâneas | Conforme |
| Observabilidade | `StructuredLogger` e eventos sem amount/payload financeiro | Conforme |
| Regressão | `bun run test`: 27 testes, 0 falhas | Conforme |

## Verificações de banco

- `migration:up` executada com PostgreSQL 16 Alpine real.
- `migration:down` executada com sucesso.
- `migration:up` reaplicada com sucesso.
- Constraints, PKs, FKs, uniques, checks e `NUMERIC(19,2)` inspecionados após a migration.
- Trigger de imutabilidade do ledger validado contra `UPDATE` direto.
- Falha forçada na persistência do ledger confirmou rollback de wallet, `OPENING` e ledger.

## Divergências e limites conhecidos

1. O tratamento completo de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, SQS, Inbox, Outbox, idempotência de apostas, reconciliação e autenticação continua fora do escopo desta feature, conforme a Spec.
2. A fase 06 de deploy não existe nesta rodada: o projeto não possui Git nem fluxo de deploy configurado. Deploy e rollback de ambiente ficam para uma fase futura aprovada separadamente.
3. A política de branch está documentada, mas o diretório de trabalho não é um repositório Git; nenhuma branch ou commit foi inventado.

## Proteções confirmadas

- `README.md` não foi alterado; seu tamanho permanece 27497 bytes.
- Nenhum domínio importa ORM, NestJS, HTTP ou SQS.
- O saldo usa string decimal no limite da aplicação e `NUMERIC(19,2)` no PostgreSQL.
- A criação positiva grava wallet, `OPENING` e ledger dentro de uma única transação.
- O ledger não possui fluxo de update/delete e o banco rejeita mutações diretas.
