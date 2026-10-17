# Uso e validação

Este documento descreve como executar, usar e validar o jungle-gaming-wagering-processor localmente.

## 1. Pré-requisitos

- Windows PowerShell ou shell compatível;
- Bun 1.4.3;
- Docker Desktop com Docker Compose;
- portas livres 5432 e 4566 para o ambiente local padrão.

Instale as dependências:

~~~
bun install --frozen-lockfile
~~~

## 2. Subir o ambiente local

Crie a configuração local a partir do exemplo:

~~~
Copy-Item .env.example .env
docker compose up -d
~~~

O Compose inicia PostgreSQL em localhost:5432, LocalStack/SQS em localhost:4566 e as filas FIFO de entrada, eventos e respectivas DLQs pelo script em infra/localstack/.

Aplique as migrations:

~~~
bun run migration:up
~~~

Execute somente a API HTTP com a configuração padrão:

~~~
bun run start:dev
~~~

Para executar a versão compilada:

~~~
bun run build
bun run start:prod
~~~

O servidor escuta em http://localhost:3000 por padrão. Para ativar o consumidor SQS e o publisher da Outbox no processo local, defina no .env:

~~~
SQS_ENABLED=true
OUTBOX_ENABLED=true
~~~

## 3. Health checks

~~~
curl.exe http://localhost:3000/health/live
curl.exe http://localhost:3000/health/ready
~~~

/health/live verifica se o processo está vivo. /health/ready verifica as dependências obrigatórias, principalmente PostgreSQL e SQS.

## 4. Fluxo HTTP completo

Defina a base da API:

~~~
$baseUrl = 'http://localhost:3000'
~~~

### 4.1 Criar uma wallet

Use um UUID válido para playerId:

~~~
$playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1'
$wallet = curl.exe -sS -X POST "$baseUrl/wallets" -H 'content-type: application/json' -d "{\"playerId\":\"$playerId\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
$wallet
~~~

Guarde o id retornado como walletId. Um saldo inicial maior que zero cria OPENING, um WalletLedgerEntry de crédito e os registros contábeis na mesma transação SQL.

Para validar uma wallet:

~~~
$walletId = '<wallet-id-retornado>'
curl.exe -sS "$baseUrl/wallets/$walletId"
curl.exe -sS "$baseUrl/wallets/$walletId/ledger?limit=50"
~~~

### 4.2 Enviar uma transação

Idempotency-Key é obrigatório. O exemplo cria um BET de 25.00:

~~~
$externalId = 'transaction-123'
$body = @"
{
  "providerId": "provider-a",
  "externalTransactionId": "$externalId",
  "playerId": "$playerId",
  "walletId": "$walletId",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
"@
curl.exe -sS -X POST "$baseUrl/wagering/transactions" -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d $body
~~~

O fluxo esperado é 201 com status PROCESSED, saldo 975.00 e um journal BET com débito e crédito balanceados.

Repita exatamente a mesma requisição para validar replay; a resposta deve ser 200 e conter idempotentReplay: true:

~~~
curl.exe -sS -X POST "$baseUrl/wagering/transactions" -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d $body
~~~

Altere money, kind ou outro campo mantendo a mesma chave para validar conflito de idempotência. O resultado esperado é 409, sem novo efeito financeiro.

### 4.3 WIN, LOSS, REFUND e ROLLBACK

O campo kind aceita BET, WIN, LOSS, REFUND e ROLLBACK.

- BET: debita a wallet;
- WIN: credita a wallet;
- LOSS: mantém o saldo e não cria journal patrimonial;
- REFUND: exige referenceExternalTransactionId de um BET processado e inverte seus postings;
- ROLLBACK: exige referenceExternalTransactionId compatível e inverte o efeito referenciado.

Para REFUND ou ROLLBACK, adicione ao JSON:

~~~
"referenceExternalTransactionId": "transaction-123"
~~~

Cada requisição deve usar um externalTransactionId e Idempotency-Key próprios.

### 4.4 Consultar transações

~~~
curl.exe -sS "$baseUrl/wagering/transactions/<transaction-id>"
curl.exe -sS "$baseUrl/providers/provider-a/wagering/transactions/transaction-123"
~~~

### 4.5 Reconciliação

~~~
curl.exe -sS -X POST "$baseUrl/wallets/$walletId/reconciliation"
~~~

Uma resposta consistente deve conter consistent: true, saldo armazenado igual ao calculado e diferença 0.00. Divergências são reportadas; não são corrigidas silenciosamente.

## 5. Fluxo SQS

Com SQS_ENABLED=true, o consumidor lê wager-transactions.fifo. Com OUTBOX_ENABLED=true, o publisher envia eventos para wager-events.fifo.

As DLQs são wager-transactions-dlq.fifo e wager-events-dlq.fifo. Para enviar uma mensagem manualmente ao LocalStack:

~~~
$message = @'
{
  "messageId": "msg-manual-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-16T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "sqs-transaction-001",
    "idempotencyKey": "provider-a:sqs-transaction-001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<wallet-id-retornado>",
    "roundId": "round-sqs-001",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "1.00", "currency": "BRL" }
  }
}
'@
docker compose exec -T localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --message-body $message --message-group-id manual-validation --message-deduplication-id msg-manual-001
~~~

Valide a execução consultando a wallet e a transação. O Inbox deve deduplicar redelivery, o ack ocorre somente após o commit e a Outbox permanece atômica com a alteração financeira.

Para inspecionar as filas:

~~~
docker compose exec -T localstack awslocal sqs list-queues
docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
~~~

## 6. Migrations e banco

Aplicar migrations pendentes:

~~~
bun run migration:up
~~~

migration:down deve ser usado somente em banco descartável para validar reversibilidade:

~~~
bun run migration:down
bun run migration:up
~~~

O ledger dobrado usa as tabelas ledger_accounts, ledger_journal_entries e ledger_postings. Journals e postings confirmados são append-only.

Auditoria rápida no banco padrão:

~~~
docker compose exec -T postgres psql -U wagering -d wagering -c "select count(*) as journals from ledger_journal_entries; select count(*) as postings from ledger_postings;"
~~~

Auditoria de journals desbalanceados:

~~~
docker compose exec -T postgres psql -U wagering -d wagering -c "select journal.id from ledger_journal_entries journal join ledger_postings posting on posting.journal_entry_id = journal.id group by journal.id, journal.currency having count(*) < 2 or count(*) filter (where posting.direction = 'DEBIT') = 0 or count(*) filter (where posting.direction = 'CREDIT') = 0 or sum(posting.amount) filter (where posting.direction = 'DEBIT') <> sum(posting.amount) filter (where posting.direction = 'CREDIT') or bool_or(posting.currency <> journal.currency);"
~~~

O resultado esperado da segunda consulta é vazio.

## 7. Validação automatizada

### Typecheck, build e unitários

~~~
bun run typecheck
bun run build
bun run test:unit
~~~

### Integração com PostgreSQL e LocalStack reais

Com docker compose up -d ativo, configure as variáveis lidas pelo harness:

~~~
$env:DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:5432/wagering'
$env:SQS_ENDPOINT = 'http://127.0.0.1:4566'
$env:SQS_QUEUE_URL = 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo'
$env:SQS_DLQ_URL = 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo'
$env:OUTBOX_EVENTS_QUEUE_URL = 'http://127.0.0.1:4566/000000000000/wager-events.fifo'
$env:OUTBOX_EVENTS_DLQ_URL = 'http://127.0.0.1:4566/000000000000/wager-events-dlq.fifo'
bun run test:integration
~~~

Os testes cobrem migrations, constraints, atomicidade, ledger dobrado, backfill, reconciliação, idempotência, HTTP, Inbox e Outbox.

### Resiliência e falhas

~~~
bun run test:resilience
~~~

O runner cria um projeto Docker isolado chamado jungle-gaming-resilience, executa cenários de crash antes/depois do commit, SIGTERM, lease recovery, falhas transitórias, poison messages e concorrência, e limpa somente esse projeto ao terminar.

### Teste de carga

Use um projeto e portas separados do ambiente de integração:

~~~
$env:RESILIENCE_POSTGRES_PORT = '26432'
$env:RESILIENCE_SQS_PORT = '24566'
$env:LOAD_SQS_PORT = '26566'
docker compose -p jungle-gaming-load -f docker-compose.resilience.yml -f docker-compose.load.yml up -d --build
~~~

Execute os quatro cenários:

~~~
$env:LOAD_DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:26432/wagering'
$env:LOAD_SQS_ENDPOINT = 'http://127.0.0.1:26566'
$env:LOAD_QUEUE_URL = 'http://127.0.0.1:26566/000000000000/wager-transactions.fifo'
$env:LOAD_DLQ_URL = 'http://127.0.0.1:26566/000000000000/wager-transactions-dlq.fifo'
$env:COMPOSE_PROJECT_NAME = 'jungle-gaming-load'
$env:LOAD_RUN_ID = 'manual-load-validation'
$env:LOAD_KEEP_ENVIRONMENT = 'true'
bun run test:load
~~~

Os relatórios JSON e Markdown são gravados em artifacts/load/. Os cenários são distributed-throughput, hot-wallet, replay-redelivery e outbox-pressure. Para uma rodada curta, defina também LOAD_WARMUP_SECONDS=1 e LOAD_DURATION_SECONDS=1.

Depois da validação:

~~~
docker compose -p jungle-gaming-load -f docker-compose.resilience.yml -f docker-compose.load.yml down
~~~

Não use down -v se precisar preservar os dados do ambiente.

## 8. Sequência recomendada de validação completa

~~~
docker compose up -d
bun run migration:up
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:resilience
bun run test:load
~~~

Resiliência e carga usam ambientes Docker isolados. Não execute os runners simultaneamente com outra rodada que use as mesmas portas.

## 9. Diagnóstico rápido

### PostgreSQL ou SQS indisponível

~~~
docker compose ps
docker compose logs postgres
docker compose logs localstack
~~~

### Porta ocupada

Use portas alternativas e ajuste as URLs correspondentes. Para carga, use as portas isoladas da seção 7; para integração, configure DATABASE_URL e SQS_* antes do teste.

### Teste de integração tentando 5432 ou ::1

O harness lê DATABASE_URL, não TEST_DATABASE_URL. Defina explicitamente DATABASE_URL com 127.0.0.1 e a porta publicada pelo Compose.

### Resultado PENDING_REFERENCE

O WIN ou reversal referencia uma operação ainda não processada. A operação fica pendente e o worker de referência tenta reprocessá-la; consulte a transação novamente após o intervalo configurado em WAGER_REFERENCE_POLL_INTERVAL_MS.

### Verificação de logs

Os logs são JSON estruturado no stdout do processo. Procure por transactionId, walletId, providerId, messageId, eventos de retry, DLQ, Inbox e Outbox. Payloads financeiros completos e segredos não devem ser registrados.

## 10. Estado atual e pendências

As validações atuais registradas para esta entrega passaram: typecheck, build, 176 testes unitários, 66 testes de integração, 14 cenários de resiliência em duas rodadas e os quatro cenários de carga. A auditoria do ledger também confirmou journals balanceados, contas compatíveis e ausência de journals processados sem postings.

Não há pendência funcional bloqueadora conhecida. Antes de considerar o projeto pronto para produção, ainda devem ser definidos fora desta entrega: autenticação/autorização real, credenciais AWS/SQS reais, estratégia de deploy, armazenamento/exportação de métricas e observabilidade operacional. A aprovação final da feature permanece uma decisão explícita do responsável pelo projeto.

