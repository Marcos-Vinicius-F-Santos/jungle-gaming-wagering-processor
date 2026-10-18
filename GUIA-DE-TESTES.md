# Guia de uso e testes

Este roteiro foi feito para validar o projeto localmente do começo ao fim. Ele cobre a API HTTP, as regras de negócio, o ledger de partidas dobradas, idempotência, referências fora de ordem, SQS/Inbox/Outbox, reconciliação, resiliência e carga.

## 1. Pré-requisitos

- Windows PowerShell;
- Bun 1.4.3 ou compatível;
- Docker Desktop em execução;
- portas 3000, 5432 e 4566 livres.

Na raiz do projeto:

~~~powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
docker compose up -d
bun run migration:up
~~~

Confira os serviços:

~~~powershell
docker compose ps
~~~

postgres e localstack devem estar saudáveis.

## 2. Verificação automática rápida

Execute primeiro as verificações sem infraestrutura externa:

~~~powershell
bun run typecheck
bun run build
bun run test:unit
~~~

Para executar a integração com PostgreSQL e LocalStack reais:

~~~powershell
$env:DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:5432/wagering'
$env:SQS_ENDPOINT = 'http://127.0.0.1:4566'
$env:SQS_QUEUE_URL = 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo'
$env:SQS_DLQ_URL = 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo'
$env:OUTBOX_EVENTS_QUEUE_URL = 'http://127.0.0.1:4566/000000000000/wager-events.fifo'
$env:OUTBOX_EVENTS_DLQ_URL = 'http://127.0.0.1:4566/000000000000/wager-events-dlq.fifo'
bun run test:integration
~~~

O resultado esperado é zero falhas.

## 3. Subir a API

Em um terminal separado:

~~~powershell
bun run start:dev
~~~

Com a configuração padrão, a API fica em http://localhost:3000.

### 3.1 Health checks

~~~powershell
curl.exe -i http://localhost:3000/health/live
curl.exe -i http://localhost:3000/health/ready
~~~

Esperado:

- /health/live: 200, processo ativo;
- /health/ready: 200, PostgreSQL e SQS acessíveis.

## 4. Fluxo HTTP principal

Os exemplos abaixo usam PowerShell. Guarde os IDs retornados, pois serão usados nos passos seguintes.

> Importante: no PowerShell, não passe JSON armazenado em variável diretamente para `curl.exe -d`, pois as aspas dos nomes das propriedades podem ser removidas. Para requests com JSON dinâmico, use `Invoke-RestMethod`, como nos exemplos abaixo.

~~~powershell
$baseUrl = 'http://localhost:3000'
$playerId = [guid]::NewGuid().ToString()
~~~

### 4.1 Criar e consultar uma wallet

~~~powershell
$walletBody = @{
  playerId = $playerId
  initialBalance = @{ amount = '1000.00'; currency = 'BRL' }
}
$walletJson = $walletBody | ConvertTo-Json -Depth 5 -Compress
$walletResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $walletJson
$walletId = $walletResponse.id
$walletResponse
~~~

Esperado: 201, saldo 1000.00, moeda BRL e version = 1.

~~~powershell
curl.exe -sS "$baseUrl/wallets/$walletId" | ConvertFrom-Json
curl.exe -sS "$baseUrl/wallets/$walletId/ledger?limit=50" | ConvertFrom-Json
~~~

Esperado: a wallet retorna 1000.00; o ledger contém o lançamento OPENING com direção CREDIT.

### 4.2 Criar wallet duplicada

Envie novamente o mesmo playerId e a mesma moeda. Esperado: 409.

~~~powershell
Invoke-RestMethod -Method Post -Uri "$baseUrl/wallets" -ContentType 'application/json' -Body $walletJson
~~~

Também teste uma wallet com saldo inicial 0.00: deve retornar 201, mas sem criar OPENING nem lançamento no ledger.

### 4.3 BET com sucesso

~~~powershell
$providerId = 'provider-manual'
$betExternalId = 'bet-manual-001'
$betObject = @{
  providerId = $providerId
  externalTransactionId = $betExternalId
  playerId = $playerId
  walletId = $walletId
  roundId = 'round-manual-001'
  gameId = 'fortune-chimp'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
}
$betBody = $betObject | ConvertTo-Json -Depth 5 -Compress
$betResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = 'provider-manual:bet-manual-001' } -Body $betBody
$betTransactionId = $betResponse.transactionId
$betResponse
~~~

Esperado: 201, status PROCESSED, saldo 975.00. O ledger deve ganhar um DEBIT de 25.00.

### 4.4 Replay e conflito de idempotência

Repita exatamente a mesma chamada. Esperado: 200 e idempotentReplay = true, sem novo débito.

Depois altere apenas money.amount para 30.00, mantendo a mesma Idempotency-Key. Esperado: 409, sem alteração do saldo.

Também teste reutilizar externalTransactionId com payload diferente e outra chave. O resultado esperado é 409 por conflito da transação externa.

### 4.5 WIN e LOSS

Para cada operação, use um externalTransactionId e uma Idempotency-Key novos.

~~~powershell
$winBody = $betObject.PSObject.Copy()
$winBody.money = @{ amount = '80.00'; currency = 'BRL' }
$winBody.externalTransactionId = 'win-manual-001'
$winBody.kind = 'WIN'
$winJson = $winBody | ConvertTo-Json -Depth 5 -Compress
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = 'provider-manual:win-manual-001' } -Body $winJson
~~~

Esperado: 201, PROCESSED, saldo 1055.00 e um CREDIT de 80.00 no ledger.

Para LOSS, altere kind para LOSS, use outro ID e outro valor. Esperado: 201, PROCESSED, saldo e versão sem alteração e nenhum novo lançamento patrimonial.

### 4.6 Saldo insuficiente

Envie um BET maior que o saldo, por exemplo 99999.00, com uma chave nova. Esperado: 422, status REJECTED, failureCode INSUFFICIENT_FUNDS e nenhum débito no ledger.

### 4.7 REFUND de BET e ROLLBACK de WIN

O valor da reversão deve ser igual ao valor da operação referenciada.

~~~powershell
$refundBody = $betObject.PSObject.Copy()
$refundBody.money = @{ amount = '25.00'; currency = 'BRL' }
$refundBody.externalTransactionId = 'refund-manual-001'
$refundBody.kind = 'REFUND'
$refundBody.referenceExternalTransactionId = $betExternalId
$refundJson = $refundBody | ConvertTo-Json -Depth 5 -Compress
Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = 'provider-manual:refund-manual-001' } -Body $refundJson
~~~

Esperado: 201 e um lançamento inverso ao BET. O replay da mesma reversão deve retornar 200 com idempotentReplay = true.

Para ROLLBACK, referencie win-manual-001, use kind = ROLLBACK, valor 80.00, ID externo e chave novos. Esperado: 201 e débito inverso de 80.00.

Tente reverter a mesma operação uma segunda vez. Esperado: 409 por reversão duplicada. Tente fazer REFUND de um WIN; esperado: 422 com REFERENCE_NOT_COMPATIBLE.

### 4.8 Referência fora de ordem

Envie primeiro um WIN referenciando um BET que ainda não existe:

~~~powershell
$pendingBody = $betObject.PSObject.Copy()
$pendingBody.money = @{ amount = '10.00'; currency = 'BRL' }
$pendingBody.externalTransactionId = 'win-pending-001'
$pendingBody.kind = 'WIN'
$pendingBody.referenceExternalTransactionId = 'bet-arriving-later-001'
$pendingJson = $pendingBody | ConvertTo-Json -Depth 5 -Compress
$pendingResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/wagering/transactions" -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = 'provider-manual:win-pending-001' } -Body $pendingJson
$pendingResponse
~~~

Esperado: 202, status PENDING_REFERENCE e nextAttemptAt preenchido. Depois envie o BET com externalTransactionId = bet-arriving-later-001. Aguarde WAGER_REFERENCE_POLL_INTERVAL_MS e consulte a transação pendente. Ela deve convergir para PROCESSED e creditar a wallet uma única vez.

Para validar expiração, repita o cenário usando uma referência que nunca será criada e consulte o registro até REJECTED/REFERENCE_NOT_FOUND.

### 4.9 Consultar transações

~~~powershell
curl.exe -sS "$baseUrl/wagering/transactions/$betTransactionId" | ConvertFrom-Json
curl.exe -sS "$baseUrl/providers/$providerId/wagering/transactions/$betExternalId" | ConvertFrom-Json
~~~

As duas consultas devem retornar a mesma transação. Teste também um UUID inexistente (404) e um identificador inválido (400).

### 4.10 Paginação e reconciliação

~~~powershell
curl.exe -sS "$baseUrl/wallets/$walletId/ledger?limit=1" | ConvertFrom-Json
curl.exe -sS -X POST "$baseUrl/wallets/$walletId/reconciliation" | ConvertFrom-Json
~~~

Se houver nextCursor, use-o em ?cursor=<valor>&limit=1. A reconciliação deve retornar consistent = true e diferença 0.00.

## 5. Fluxo SQS, Inbox e Outbox

Pare a API, edite .env e ative:

~~~dotenv
SQS_ENABLED=true
OUTBOX_ENABLED=true
~~~

Suba novamente a API com bun run start:dev. Liste as filas:

~~~powershell
docker compose exec -T localstack awslocal sqs list-queues
~~~

Envie uma mensagem para a fila de entrada, substituindo <wallet-id> e <player-id>:

~~~powershell
$message = @'
{
  "messageId": "manual-sqs-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-16T12:00:00.000Z",
  "data": {
    "providerId": "provider-sqs",
    "externalTransactionId": "sqs-bet-001",
    "idempotencyKey": "provider-sqs:sqs-bet-001",
    "playerId": "<player-id>",
    "walletId": "<wallet-id>",
    "roundId": "round-sqs-001",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "1.00", "currency": "BRL" }
  }
}
'@
docker compose exec -T localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --message-body $message --message-group-id manual-validation --message-deduplication-id manual-sqs-001
~~~

Valide que:

1. a transação aparece como PROCESSED;
2. a wallet é debitada uma única vez;
3. reenviar a mesma mensagem não gera segundo efeito, pois o Inbox deduplica;
4. a mensagem só é confirmada depois do commit;
5. com a Outbox ativa, os eventos chegam a wager-events.fifo.

Inspecione as filas:

~~~powershell
docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/wager-transactions.fifo --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo --attribute-names ApproximateNumberOfMessages
~~~

## 6. Auditoria do ledger no PostgreSQL

~~~powershell
docker compose exec -T postgres psql -U wagering -d wagering -c "select count(*) as journals from ledger_journal_entries; select count(*) as postings from ledger_postings;"
~~~

A consulta abaixo deve retornar zero linhas: nenhum journal confirmado pode ficar sem débito/crédito balanceados.

~~~powershell
docker compose exec -T postgres psql -U wagering -d wagering -c "select journal.id from ledger_journal_entries journal join ledger_postings posting on posting.journal_entry_id = journal.id group by journal.id, journal.currency having count(*) < 2 or count(*) filter (where posting.direction = 'DEBIT') = 0 or count(*) filter (where posting.direction = 'CREDIT') = 0 or sum(posting.amount) filter (where posting.direction = 'DEBIT') <> sum(posting.amount) filter (where posting.direction = 'CREDIT') or bool_or(posting.currency <> journal.currency);"
~~~

Uma correção de saldo deve ocorrer por nova transação, nunca por alteração ou exclusão de lançamento.

## 7. Resiliência e falhas

O runner cria um ambiente Docker isolado, com três instâncias da aplicação, e executa crash antes do commit, crash depois do commit, SIGTERM, recuperação de lease, falhas transitórias, poison messages e concorrência:

~~~powershell
bun run test:resilience
~~~

Esperado: duas rodadas completas, sem falhas, com limpeza do projeto jungle-gaming-resilience ao final.

## 8. Teste de carga

Use portas diferentes do ambiente local:

~~~powershell
$env:RESILIENCE_POSTGRES_PORT = '26432'
$env:RESILIENCE_SQS_PORT = '24566'
$env:LOAD_SQS_PORT = '26566'
docker compose -p jungle-gaming-load -f docker-compose.resilience.yml -f docker-compose.load.yml up -d --build
~~~

Para uma rodada curta:

~~~powershell
$env:LOAD_DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:26432/wagering'
$env:LOAD_SQS_ENDPOINT = 'http://127.0.0.1:26566'
$env:LOAD_QUEUE_URL = 'http://127.0.0.1:26566/000000000000/wager-transactions.fifo'
$env:LOAD_DLQ_URL = 'http://127.0.0.1:26566/000000000000/wager-transactions-dlq.fifo'
$env:COMPOSE_PROJECT_NAME = 'jungle-gaming-load'
$env:LOAD_RUN_ID = 'manual-load-validation'
$env:LOAD_WARMUP_SECONDS = '1'
$env:LOAD_DURATION_SECONDS = '1'
$env:LOAD_KEEP_ENVIRONMENT = 'true'
bun run test:load
~~~

Os quatro cenários esperados são distributed-throughput, hot-wallet, replay-redelivery e outbox-pressure. Os relatórios ficam em artifacts/load/.

Finalize o ambiente de carga:

~~~powershell
docker compose -p jungle-gaming-load -f docker-compose.resilience.yml -f docker-compose.load.yml down
~~~

## 9. Roteiro ponta a ponta no formato da avaliação

Se o objetivo é reproduzir a validação dos avaliadores, execute esta sequência em ordem. A API pode estar parada durante as suites automatizadas.

### 9.1 Preparação

Use um banco e filas locais disponíveis:

~~~powershell
docker compose up -d
bun run migration:up
$env:DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:5432/wagering'
$env:SQS_ENDPOINT = 'http://127.0.0.1:4566'
$env:SQS_QUEUE_URL = 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo'
$env:SQS_DLQ_URL = 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo'
$env:OUTBOX_EVENTS_QUEUE_URL = 'http://127.0.0.1:4566/000000000000/wager-events.fifo'
$env:OUTBOX_EVENTS_DLQ_URL = 'http://127.0.0.1:4566/000000000000/wager-events-dlq.fifo'
~~~

### 9.2 Sequência oficial

~~~powershell
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:resilience
# Antes deste comando, suba o ambiente de carga e defina as variáveis da seção 8.
bun run test:load
bun test
~~~

O último comando é uma regressão geral. Os testes de resiliência e carga usam ambientes isolados; não os execute em paralelo.

Para uma execução mais rápida, os dois primeiros blocos podem ser separados assim:

~~~powershell
bun test test/integration/wagering.concurrency.test.ts test/integration/win-loss.concurrency.test.ts
bun test test/integration/sqs.inbox.test.ts test/integration/outbox.publisher.sqs.test.ts
~~~

### 9.3 Correspondência com os requisitos dos avaliadores

| Requisito avaliado | Onde validar |
|---|---|
| Money, escala, arredondamento e entradas inválidas | test/unit/money.test.ts |
| Invariantes da Wallet | test/unit/wallet.test.ts e test/integration/wallets.http.test.ts |
| BET, WIN, LOSS, REFUND e ROLLBACK | test/integration/wagering.http.test.ts, win-loss.http.test.ts e refund-rollback.http.test.ts |
| Idempotência com payload divergente | test/unit/wagering-idempotency.test.ts e wagering.concurrency.test.ts |
| Migrations, constraints e atomicidade | test/integration/database.atomicity.test.ts, double-entry-ledger.constraints.test.ts e wagering.atomicity.test.ts |
| Inbox, redelivery e ack após commit | test/integration/sqs.inbox.test.ts e test/integration/inbox.claim.test.ts |
| Publishers concorrentes e Outbox | test/integration/outbox.publisher.sqs.test.ts e win-loss.outbox.atomicity.test.ts |
| Retry e DLQ | test/integration/outbox.publisher.sqs.test.ts, test/resilience/resilience.failures.test.ts e artifacts/load |
| 50 replays da mesma aposta em paralelo | test/integration/wagering.concurrency.test.ts |
| Duas operações disputando o saldo da mesma wallet | test/integration/wagering.concurrency.test.ts |
| Wallets distintas em paralelo | test/integration/wagering.concurrency.test.ts |
| Pelo menos três instâncias | bun run test:resilience e bun run test:load |
| Worker morto antes/depois do commit | test/resilience/resilience.crash-before-commit.test.ts e resilience.crash-after-commit.test.ts |
| ROLLBACK/REFUND antes da referência | test/integration/win-loss.pending-reference.test.ts e refund-rollback.http.test.ts |
| Reinício, SIGTERM e recuperação de lease | bun run test:resilience |
| Consistência final wallet = ledger | reconciliação HTTP, ledger-reconciliation.test.ts e invariantes dos runners |

### 9.4 Evidências para conferir no final

Considere a rodada aprovada somente se:

1. typecheck e build terminarem sem erro;
2. a suíte unitária e a integração não tiverem falhas;
3. cada cenário de resiliência terminar como passed;
4. cada cenário de carga terminar como passed e com filas drenadas;
5. a auditoria SQL não retornar journal desbalanceado;
6. a reconciliação retornar consistent = true e diferença 0.00;
7. não houver mensagem inesperada nas DLQs;
8. os relatórios de carga estiverem em artifacts/load/.


## 10. Matriz de aceite

| Área | Cenário | Resultado esperado |
|---|---|---|
| Saúde | /health/live e /health/ready | 200 |
| Wallet | criação positiva | 201, OPENING, saldo correto |
| Wallet | duplicidade | 409 |
| Wallet | saldo zero | 201, sem OPENING |
| BET | débito válido | 201/PROCESSED |
| BET | replay idêntico | 200, idempotentReplay=true |
| BET | mesma chave com payload diferente | 409 |
| BET | saldo insuficiente | 422/INSUFFICIENT_FUNDS |
| WIN | crédito válido | 201/PROCESSED |
| LOSS | perda | 201/PROCESSED, sem efeito patrimonial |
| Reversão | REFUND de BET | crédito inverso, uma vez |
| Reversão | ROLLBACK de WIN | débito inverso, uma vez |
| Referência | operação fora de ordem | 202/PENDING_REFERENCE, depois converge |
| Consultas | por ID e por provider/external ID | mesmo registro |
| Ledger | paginação e reconciliação | cursor válido, consistent=true |
| SQS | redelivery | um efeito financeiro |
| Outbox | evento após commit | evento persistido/publicado |
| Resiliência | crashes, SIGTERM, leases e DLQ | invariantes preservadas |
| Carga | quatro cenários | relatório passed, filas drenadas |

## 11. Diagnóstico rápido

~~~powershell
docker compose ps
docker compose logs postgres
docker compose logs localstack
~~~

Se a integração tentar ::1 ou outra porta, defina explicitamente DATABASE_URL com 127.0.0.1. Se a operação retornar PENDING_REFERENCE, consulte o registro novamente depois de WAGER_REFERENCE_POLL_INTERVAL_MS. Em caso de resposta 503, verifique os logs e repita a operação com a mesma Idempotency-Key quando o commit não puder ser confirmado.

Para uma referência mais curta de execução, consulte também [USAGE.md](USAGE.md).

## 12. Executar pelo Postman

Para validar manualmente a API HTTP, importe estes dois arquivos no Postman:

- `postman/Jungle-Gaming-API.postman_collection.json`;
- `postman/Jungle-Gaming-Local.postman_environment.json`.

Selecione o ambiente `Jungle Gaming - Local` e execute as pastas na ordem. A coleção captura automaticamente `playerId`, `walletId`, IDs de transação e chaves de idempotência. A operação `Consultar WIN pendente até convergir` deve ser executada novamente depois do intervalo configurado em `WAGER_REFERENCE_POLL_INTERVAL_MS`.

A coleção cobre o fluxo HTTP manual. Concorrência real, 50 replays em paralelo, múltiplas instâncias, SQS/Inbox/Outbox, crash recovery, SIGTERM, DLQ e carga continuam sendo validados pelos comandos Bun e Docker das seções anteriores.

