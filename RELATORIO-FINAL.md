# Relatório final de validação

## Resultado geral

Entrega validada localmente com Docker, PostgreSQL, LocalStack/SQS e API NestJS. O fluxo principal e os cenários adicionais foram executados com sucesso.

## Fluxo HTTP

- Liveness e readiness: `200 OK`.
- Criação, consulta e ledger inicial da wallet: aprovados.
- Criação duplicada de wallet: `409 Conflict`.
- BET, WIN, LOSS, REFUND e ROLLBACK: aprovados.
- Idempotência: criação `201`, replay idêntico `200` e conflito de payload `409`.
- Ausência de `Idempotency-Key`: `400 Bad Request`.
- Referência fora de ordem: `202 PENDING_REFERENCE`, convergência posterior para `PROCESSED` e efeito financeiro único.
- Wallet inexistente: `404 Not Found`.
- Limite inválido no ledger: `400 Bad Request`.
- Reversão duplicada: `409 Conflict`.

## Ledger e reconciliação

- Reconciliação manual: saldo armazenado e calculado em `925.00 BRL`.
- Diferença: `0.00 BRL`.
- `consistent: true` e nenhuma inconsistência.

## SQS, Inbox e Outbox

- Mensagem SQS válida processada como `PROCESSED`.
- BET SQS de `1.00 BRL`: saldo de `925.00` para `924.00 BRL`.
- Redelivery da mesma mensagem: replay reconhecido pelo Inbox, sem segundo débito.
- Outbox publicou `WagerTransactionProcessed` e `WalletBalanceChanged`.
- Mensagem inicialmente inválida foi rejeitada sem alterar o saldo; o envio corrigido foi processado corretamente.

## Suítes automatizadas

### Concorrência

- 6 testes aprovados.
- 0 falhas.
- Incluiu disputa de saldo, replays paralelos e cenários WIN/LOSS.

### Resiliência

As duas rodadas passaram nos cenários de baseline, três instâncias concorrentes, crash antes do commit, crash após commit antes do ACK, recuperação de lease, SIGTERM e falhas transitórias/poison/DLQ.

### Carga

Relatório: `artifacts/load/manual-load-validation.md`.

- `distributed-throughput`: passed.
- `hot-wallet`: passed.
- `replay-redelivery`: passed.
- `outbox-pressure`: passed.
- Status geral: `passed`.

## Conteúdo da entrega

- Código-fonte em `src/`.
- Testes unitários, de integração, resiliência e carga em `test/`.
- Migrations e inicialização do LocalStack em `infra/`.
- Coleção e ambiente Postman em `postman/`.
- Documentação em `README.md`, `USAGE.md`, `ARCHITECTURE.md` e `GUIA-DE-TESTES.md`.
- Configurações Docker e `.env.example`.
- Evidências do teste de carga em `artifacts/load/`.

## Exclusões de segurança

Não foram incluídos `.env`, `node_modules`, `dist`, volumes Docker, caches ou credenciais locais.

