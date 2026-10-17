# Verificação Operacional — Processar WIN e LOSS

Status: Implementação verificada tecnicamente e aprovada por Marcos em 2026-10-16.

## Documentos comparados

- Spec: [`../03-features/03-processar-win-loss/spec.md`](../03-features/03-processar-win-loss/spec.md)
- Plano: [`../04-plano/03-processar-win-loss/plano.md`](../04-plano/03-processar-win-loss/plano.md)
- Tarefas: [`../04-plano/03-processar-win-loss/tarefas.md`](../04-plano/03-processar-win-loss/tarefas.md)
- Arquitetura: [`../02-arquitetura/arquitetura.md`](../02-arquitetura/arquitetura.md)

## Resultado por tarefa

| Tarefa | Resultado | Evidência principal |
|---|---|---|
| T-001 | Executada | Boundaries confirmados: HTTP, BET e worker reutilizam o mesmo caso de uso |
| T-002 | Executada | `Migration20261015210000.ts`; `up/down` ainda depende de PostgreSQL disponível |
| T-003 | Executada | Entidade, domínio, record e adapter transportam referência e pendência |
| T-004 | Executada | `Wallet.credit` e testes unitários |
| T-005 | Executada | Command, referência opcional e hash canônico |
| T-006 | Executada | `WagerReferenceValidator` e testes de compatibilidade |
| T-007 | Executada | WIN, crédito e ledger `CREDIT` |
| T-008 | Executada | LOSS sem alteração de saldo/version/ledger |
| T-009 | Executada | Backoff, TTL, transições e consulta de pendências |
| T-010 | Executada | Outbox mínima, envelope, adapter e migration |
| T-011 | Executada | Replay e conflito para WIN/LOSS; retry limitado reutilizado |
| T-012 | Executada | Enfileiramento transacional e logs com `eventId` |
| T-013 | Executada | DTO, moeda normalizada e referência opcional |
| T-014 | Executada | Mapeamentos `201`, `200`, `202`, `400`, `404`, `409`, `422`, `503` |
| T-015 | Executada | Worker persistente de referências pendentes |
| T-016 | Executada | Cobertura unitária de domínio, referências, pending, WIN, LOSS e Outbox |
| T-017 | Verificada tecnicamente | Em banco isolado `wagering_t017_20261016`: ciclo `up/down/up` passou; schema, constraints e índices conferidos; 6 testes reais de migration/atomicidade passaram. Resultado técnico registrado. |
| T-018 | Verificada tecnicamente | `win-loss.http.test.ts`: 3 passaram (201 WIN, 201 LOSS e 202 pending). A regressão HTTP BET passou em 6/6 após o ajuste do ciclo de vida do worker. Resultado técnico registrado. |
| T-019 | Verificada tecnicamente | Concorrência/replay real: 3 passaram (2 WINs concorrentes, 50 replays WIN e 50 replays LOSS); asserts corrigidos para excluir o `OPENING` do contador de créditos. Regressão BET concorrente passou em 3/3 na execução conjunta anterior. Resultado técnico registrado. |
| T-020 | Verificada tecnicamente | 2 testes reais passaram: referência BET surgindo antes do TTL processa a WIN uma vez; pendência além de 15 minutos expira como `REJECTED/REFERENCE_NOT_FOUND` e gera `WagerTransactionRejected` sem ledger. Resultado técnico registrado. |
| T-021 | Verificada e aprovada | `typecheck`, `build`, ciclo de migration em banco isolado e suíte completa passaram; 76 testes passaram, 0 falharam. Aprovação explícita registrada em 2026-10-16. |

## Verificações executadas

### T-017 — PostgreSQL isolado

```text
Banco: wagering_t017_20261016 (container junglegaming-postgres-1, PostgreSQL 16-alpine, healthy)
bun run migration:up    -> passou (4 migrations aplicadas)
bun run migration:down  -> passou (Migration20261015220000 revertida)
bun run migration:up    -> passou (Migration20261015220000 reaplicada)

Schema conferido:
- referências e pendência: reference_external_transaction_id, pending_since, next_attempt_at, pending_attempts
- Outbox: event_id, aggregate_id, event_type, version, payload, attempts, next_attempt_at, published_at
- uniques preservadas: provider/external e provider/idempotency_key
- índices de pendência presentes: wager_transactions_pending_reference_due_idx e outbox_messages_pending_due_idx

bun test test/integration/database.atomicity.test.ts test/integration/wagering.atomicity.test.ts test/integration/win-loss.outbox.atomicity.test.ts
-> 6 passaram, 0 falharam
```

### T-018 — HTTP e T-019 — concorrência/replay

```text
bun test test/integration/win-loss.http.test.ts
-> 3 passaram, 0 falharam

bun test test/integration/win-loss.concurrency.test.ts
-> 3 passaram, 0 falharam
  - duas WINs concorrentes: saldo 260.00, versão 3, dois créditos WIN
  - 50 replays da mesma WIN: um efeito financeiro
  - 50 replays da mesma LOSS: um registro auditável, saldo/version/ledger sem efeito

Regressão adicional:
bun test test/integration/wagering.concurrency.test.ts
-> 3 passaram, 0 falharam na execução conjunta com T-019

Regressão HTTP BET na primeira execução:
bun test test/integration/wagering.http.test.ts
-> 5 passaram, 1 falhou no cenário artificial de 503 por `DriverException` do pool do MikroORM
   (`undefined is not an object (evaluating 'this.#pool.Client')`) durante a aplicação transitória.
Após o ajuste do ciclo de vida do worker, o mesmo arquivo passou em 6/6; o cenário isolado de 503 também passou.

T-020:
bun test test/integration/win-loss.pending-reference.test.ts
-> 2 passaram, 0 falharam
  - referência disponível: WIN processada uma vez, saldo 170.00 e um crédito
  - TTL expirado: REJECTED/REFERENCE_NOT_FOUND, sem ledger e um evento de rejeição

T-021 — convergência final:
bun run typecheck -> passou
bun run build      -> passou
bun test           -> 76 passaram, 0 falharam, 229 expect() calls, 27 arquivos
```

O ciclo `migration:up/down/up` e os testes PostgreSQL foram executados no banco isolado
`wagering_t017_20261016`, para não alterar o banco padrão local.

Verificações anteriores ao Docker ficar acessível (histórico):

```text
bun run typecheck  -> passou
bun run build      -> passou
bun test test/unit -> 44 passaram, 0 falharam
bun test           -> 44 passaram; 31 falharam por indisponibilidade do PostgreSQL/listener local
```

Na execução anterior, o erro comum da suíte de integração foi `EACCES` ao conectar em `::1:5432`/`127.0.0.1:5432`; o Docker Desktop também retornou `permission denied` ao acessar o socket do Docker. Depois, T-017–T-020 foram executadas no banco isolado acima, com evidência real, e a suíte completa passou.

## Aprovação

Marcos aprovou explicitamente a implementação da feature Processar WIN e LOSS em 2026-10-16, após a verificação técnica registrada acima. Essa aprovação não altera os resultados dos testes nem cria evidência adicional.

## Divergências registradas

- `specs/00-principios/principios.md` é referenciado pelo `AGENTS.md`, mas não existe no checkout atual; foram usadas as regras disponíveis no `AGENTS.md`, README, Spec e Arquitetura.
- A publicação externa da Outbox por SQS permanece fora desta feature, conforme decisão aprovada; a persistência transacional dos eventos foi implementada.
- A fase 06 de deploy não foi criada, conforme decisão aprovada e ausência de Git/fluxo de deploy.
- O assert de concorrência WIN foi corrigido para contar somente créditos das transações `WIN`, excluindo o lançamento `OPENING`; também foi acrescentado o replay paralelo de `LOSS`.
- O worker de referências pendentes passou a tratar falhas assíncronas e aguardar uma varredura ativa no encerramento, evitando erros não tratados durante o ciclo de vida HTTP/testes.
- `README.md` permaneceu intocado; tamanho e SHA-256 foram preservados.
