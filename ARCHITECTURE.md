# Arquitetura e regras consolidadas

Este documento é um guia de implementação para o desafio descrito no `README.md`. O `README.md` permanece como especificação original e fonte normativa; este arquivo organiza os requisitos em decisões arquiteturais, invariantes e fluxos executáveis.

## 1. Objetivo do sistema

Construir um serviço financeiro distribuído que processe operações de apostas recebidas de múltiplos provedores, mantendo correção sob:

- entrega at-least-once;
- mensagens duplicadas ou fora de ordem;
- concorrência entre múltiplas instâncias;
- reinício ou queda de processo em qualquer ponto do fluxo;
- indisponibilidade temporária de PostgreSQL ou SQS.

O sistema não é um CRUD. A avaliação prioriza correção financeira, concorrência, idempotência persistente, consistência entre saldo e ledger, processamento assíncrono, recuperação após falhas e clareza arquitetural.

## 2. Stack e limites obrigatórios

| Área | Regra |
|---|---|
| Runtime, package manager e test runner | Bun 1.x |
| Linguagem | TypeScript em modo estrito |
| Framework | NestJS |
| Banco | PostgreSQL |
| Mensageria | AWS SQS via LocalStack ou MiniStack |
| Orquestração | Docker Compose |
| Migrations | Versionadas e reversíveis |
| ORM | MikroORM |
| Fora do escopo | Prisma e outros ORMs |

Autenticação ficará fora da primeira fase. O ponto de extensão deve continuar explícito, como um `AuthGuard` no-op ou `ProviderIdentityPort`, para permitir integração futura com um Identity Provider externo. Health checks ficam abertos; mensagens da fila são canal interno confiável, mas o `providerId` nelas continua sujeito às validações de domínio.

## 3. Restrições invioláveis

1. Nunca usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. SQS FIFO é otimização, não garantia de consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não fazer `read → calculate → update` sem controle de concorrência.
8. A solução deve funcionar com múltiplas instâncias, incluindo três ou mais processos.
9. Unicidade, imutabilidade e não-negatividade precisam estar protegidas no schema do banco, além da aplicação.
10. `OPENING` é transação interna e não pode ser submetida pela API nem pela fila.
11. Factories públicas validam regras de criação; `rehydrate` apenas reconstrói estado persistido.

## 4. Invariantes de negócio

- Existe no máximo uma wallet por `(playerId, currency)`.
- O saldo nunca fica negativo.
- Toda alteração de saldo tem um lançamento correspondente no ledger, e vice-versa.
- Uma transação financeira produz no máximo um lançamento por wallet.
- `LOSS` e transações rejeitadas não alteram saldo nem geram ledger.
- A moeda da operação precisa ser igual à da wallet e à da referência quando houver.
- `version` começa em `1` e incrementa somente quando o saldo muda.
- O saldo materializado é sempre reconstruível pelo ledger.
- `PROCESSED`, `REJECTED` e `FAILED` são estados terminais.
- A mesma idempotency key com payload igual é replay; com payload diferente é conflito.
- `REFUND` e `ROLLBACK` exigem referência e só podem reverter uma referência uma vez por tipo.
- Reversão que causaria saldo negativo deve ser rejeitada com código diferente de saldo insuficiente.
- Operações dependentes que chegam antes da referência ficam pendentes e são reprocessadas.

## 5. Arquitetura recomendada

Adotar arquitetura hexagonal/modular. O domínio não conhece NestJS, ORM, HTTP, SQS ou decorators.

```text
src/
  domain/
    money/
    wallet/
    wagering/
    ledger/
    messaging/
    events/
    shared/
  application/
    wallets/
    wagering/
    reconciliation/
    inbox/
    outbox/
  infrastructure/
    persistence/postgres/
    migrations/
    messaging/sqs/
    observability/
    auth/
  interfaces/
    http/
    consumers/
    workers/
  app.module.ts
```

### 5.1 Camadas

| Camada | Responsabilidade | Limite |
|---|---|---|
| `domain` | Value objects, agregados, regras, estados e eventos | Não conhece infraestrutura |
| `application` | Casos de uso, transações, orquestração e portas | Não depende de driver concreto |
| `infrastructure` | PostgreSQL, ORM, SQS, métricas, logs e adapters | Não decide regras silenciosamente |
| `interfaces/http` | DTOs, controllers, autenticação e mapeamento HTTP | Nunca altera saldo diretamente |
| `interfaces/consumers` | Envelope SQS, chamada do caso de uso e ack/retry | Não duplica lógica financeira |
| `interfaces/workers` | Outbox e referências pendentes | Nunca publica antes do commit |

### 5.2 Portas mínimas

- `WalletRepository`: busca, criação e atualização com lock apropriado.
- `WagerTransactionRepository`: busca por id, idempotency key e identificador externo.
- `LedgerRepository`: inserção e leitura; sem update/delete público.
- `InboxRepository`: registro único por `(consumerName, messageId)`.
- `OutboxRepository`: inserção, claim concorrente, publicação e retry.
- `UnitOfWork`/`TransactionManager`: uma transação SQL para todas as escritas financeiras.
- `MessagePublisher` e `MessageConsumer`: abstração de SQS.
- `Clock`, `IdGenerator`, `PayloadHasher`, `Logger` e `Metrics`.

## 6. Modelo de domínio

### 6.1 `Money`

Value object imutável. Recebe e serializa `{ amount: string, currency: string }`, sempre com duas casas decimais. Deve rejeitar string vazia, `NaN`, `Infinity`, notação científica, mais de duas casas e entradas negativas quando o contrato não as permitir. Operações entre moedas diferentes lançam erro de domínio.

Persistir como `NUMERIC`/`DECIMAL` com escala definida ou como inteiro em centavos. A escolha precisa ser documentada. O domínio não depende dos tipos monetários do ORM.

### 6.2 `Wallet`

Aggregate root da unidade de concorrência `walletId`. Encapsula saldo e versão e expõe `debit`/`credit`. `open` cria a wallet; `rehydrate` reconstrói o estado persistido sem revalidar transições. Saldo negativo e moeda incompatível são proibidos.

### 6.3 `WagerTransaction`

Registra a intenção, o payload hash, a operação do provedor, referências, estado, failure code e resultado. Os kinds são:

- `OPENING`: interno, crédito de abertura;
- `BET`: débito, rejeita saldo insuficiente;
- `WIN`: crédito, pode referenciar `BET`;
- `LOSS`: sem alteração de saldo;
- `REFUND`: crédito que reverte `BET` processada;
- `ROLLBACK`: inversão de `BET`, `WIN` ou `REFUND` processada.

Referências resolvem por `(providerId, referenceExternalTransactionId)` e devem pertencer ao mesmo provider, player, wallet, moeda e rodada. `REFUND`/`ROLLBACK` devem ter o mesmo valor da referência.

### 6.4 `WalletLedgerEntry`

Registro imutável de uma alteração. Contém direção, valor, saldo anterior e posterior e valida `balanceBefore ± money = balanceAfter`. Criar unicidade por `(walletId, transactionId)`. Não expor métodos de alteração.

### 6.5 Inbox e Outbox

`InboxMessage` registra a entrega de uma mensagem SQS e é único por `(consumerName, messageId)`. `OutboxMessage` registra o envelope de integração dentro da transação financeira e é publicado posteriormente. Ambos participam da mesma transação SQL quando a entrada é SQS.

## 7. Estados e failure codes

```text
PENDING ───────────────► PROCESSED
   │  \                 ▲
   │   └──────────────► REJECTED
   │
   ├──────────────────► PENDING_REFERENCE ──► PROCESSED
   │                                      \──► REJECTED
   └──────────────────► FAILED
```

- `PENDING`: aceito e ainda não aplicado.
- `PENDING_REFERENCE`: referência ausente; aguarda worker com backoff.
- `PROCESSED`: aplicado; pode ter ledger ou ser `LOSS`.
- `REJECTED`: regra de negócio violada, terminal e auditável.
- `FAILED`: erro permanente de infraestrutura, terminal e auditável.

Taxonomia recomendada:

| Código | Significado |
|---|---|
| `INVALID_PAYLOAD` | Formato ou campo inválido |
| `IDEMPOTENCY_CONFLICT` | Mesma key com payload diferente |
| `WALLET_NOT_FOUND` | Wallet inexistente ou incompatível |
| `CURRENCY_MISMATCH` | Moedas incompatíveis |
| `INSUFFICIENT_FUNDS` | `BET` sem saldo |
| `REVERSAL_NEGATIVE_BALANCE` | Reversão causaria saldo negativo |
| `REFERENCE_NOT_FOUND` | Referência ausente após limite/TTL |
| `REFERENCE_INVALID_KIND` | Tipo de referência inválido |
| `REFERENCE_ALREADY_REVERSED` | Reversão duplicada |
| `REFERENCE_MISMATCH` | Player, wallet, rodada, valor ou moeda divergente |
| `INFRASTRUCTURE_PERMANENT` | Falha permanente não recuperável |

Os códigos devem ser estáveis e legíveis por máquina. Tentativas de mudar um estado terminal são erros de programação, não um caminho de negócio.

## 8. PostgreSQL, constraints e concorrência

### 8.1 Tabelas e garantias

- `wallets`: PK, `player_id`, `currency`, valor exato, `version`, timestamps e `UNIQUE(player_id, currency)`; `CHECK` para saldo não negativo.
- `wager_transactions`: IDs, provider/external ID, idempotency key, payload hash, wallet/player/round/game, kind, valor, referência, status, failure code e timestamps; unicidade para `(provider_id, external_transaction_id)` e para a idempotency key no escopo adotado.
- `wallet_ledger_entries`: PK, wallet, transaction, direção, valor, saldo antes/depois e timestamp; `UNIQUE(wallet_id, transaction_id)`; impedir update/delete.
- `inbox_messages`: `UNIQUE(consumer_name, message_id)` e payload hash.
- `outbox_messages`: event ID único, aggregate ID, tipo, versão, payload JSONB, tentativas, próximo retry e data de publicação; índice para mensagens pendentes.

### 8.2 Estratégia recomendada

Usar optimistic locking por wallet com `version` e retry limitado, mantendo wallets diferentes em paralelo. O `UPDATE` condicionado deve verificar exatamente uma linha afetada; ao esgotar o retry, a falha deve ser observável e classificável. Não usar lock global. Lock pessimista pode ser considerado apenas se uma decisão posterior, formalmente registrada, justificar a mudança.

Fluxo de alteração:

1. Abrir transação SQL.
2. Registrar Inbox, se a origem for SQS.
3. Resolver idempotency key e payload hash.
4. Retornar o resultado persistido para replay idêntico; abortar sem efeito em conflito.
5. Inserir ou carregar a transação em `PENDING`.
6. Bloquear a wallet.
7. Validar referência, player, wallet, moeda, rodada, valor e regras do kind.
8. Aplicar `debit`/`credit`, criar no máximo um ledger e atualizar saldo/version.
9. Persistir a transação e os eventos na Outbox.
10. Marcar Inbox como processado e fazer commit.
11. Responder HTTP ou fazer ack somente depois do commit.

### 8.3 Cenário obrigatório

Para saldo inicial `100.00 BRL` e duas apostas concorrentes de `80.00 BRL`:

- exatamente uma transação fica `PROCESSED`;
- a outra fica `REJECTED` por `INSUFFICIENT_FUNDS`;
- saldo final é `20.00 BRL`;
- existe exatamente um débito no ledger;
- retries não duplicam o débito.

## 9. Fluxos de aplicação

### 9.1 Criação de wallet

Validar `playerId` e `Money`, inserir a wallet com `version = 1` e proteger a unicidade. Se o saldo inicial for maior que zero, criar `OPENING`, o crédito no ledger e os eventos na mesma transação SQL. Conflito de `(playerId, currency)` retorna conflito.

### 9.2 Entrada HTTP

```text
DTO → ProcessWagerTransaction
    → SQL: transaction + wallet + ledger + outbox
    → commit
    → resposta persistida
```

O header `Idempotency-Key` é obrigatório. O hash é de JSON canônico com chaves ordenadas e somente campos de negócio; header e metadados de transporte ficam fora do hash. O replay retorna o resultado original, incluindo o saldo observado naquele momento.

### 9.3 Consumidor SQS

```text
receive → validar envelope → Inbox unique → mesmo caso de uso HTTP
        → commit → ack
        ├─ rejeição de negócio: persistir → ack
        ├─ falha transitória: não ack → retry/backoff
        └─ falha permanente: limite → DLQ
```

O consumidor deve suportar redelivery e concluir mensagens em andamento ou devolver a visibilidade em `SIGTERM`. A lógica financeira não pode ser duplicada no adapter SQS.

### 9.4 Referências fora de ordem

Persistir `PENDING_REFERENCE`, publicar `WagerTransactionPendingReference` e reprocessar com backoff. O TTL total é de 15 minutos desde a primeira persistência como pendência, com cinco retries em `30s`, `1m`, `2m`, `4m` e `7m`; nunca agendar além do TTL. Ao esgotar, rejeitar com `REFERENCE_NOT_FOUND` e publicar `WagerTransactionRejected`. Redelivery não reinicia o TTL.

### 9.5 Transactional Outbox

O publisher seleciona pendentes com `FOR UPDATE SKIP LOCKED` ou claim equivalente, publica e marca como publicado. Crash entre publicação e marcação pode causar duplicata; consumidores devem ser idempotentes por `eventId`. O requisito é não perder eventos confirmados e não duplicar indefinidamente.

### 9.6 Reconciliação

Somar o ledger em ordem estável, comparar com o saldo materializado e retornar ambos, a diferença, `consistent` e `checkedEntries`. Nunca corrigir divergência silenciosamente: registrar log, métrica e sinalização na resposta.

## 10. API e status HTTP

Endpoints obrigatórios:

- `POST /wallets`;
- `GET /wallets/:walletId`;
- `GET /wallets/:walletId/ledger?cursor=...&limit=50`;
- `GET /wagering/transactions/:transactionId`;
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`;
- `POST /wagering/transactions`;
- `POST /wallets/:walletId/reconciliation`;
- `GET /health/live`;
- `GET /health/ready`.

Mapeamento recomendado:

| Situação | Status |
|---|---:|
| Payload inválido | `400` |
| Não autenticado/autorização | `401`/`403`, se auth habilitada |
| Recurso inexistente | `404` |
| Conflito de idempotência ou wallet duplicada | `409` |
| Rejeição de negócio | `422` |
| Referência pendente | `202` |
| Processado | `200` ou `201`, de forma consistente |
| Falha transitória | `503` |
| Falha permanente auditável | `500`/`502` |

Health endpoints não exigem autenticação. Cursor de ledger deve ser estável e opaco.

## 11. Eventos e observabilidade

Eventos mínimos:

- `WagerTransactionProcessed`, inclusive `LOSS`;
- `WagerTransactionRejected`;
- `WalletBalanceChanged`, somente quando o saldo muda;
- `WagerTransactionPendingReference`.

Cada evento é uma subclasse concreta de `IntegrationEvent`, com `eventType` e `version` no tipo. `Money` no payload é sempre `MoneyProps`, nunca instância de classe.

Logs são JSON estruturado com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` quando disponíveis. Não registrar payload financeiro completo nem dados sensíveis.

Métricas mínimas:

- transações por status;
- duplicatas detectadas;
- retries;
- mensagens na DLQ;
- conflitos de lock;
- outbox lag;
- latência de processamento.

## 12. Testes obrigatórios

### Unidade

- Money: escala, arredondamento, entradas inválidas e moedas diferentes;
- invariantes de Wallet;
- regras de BET, WIN, LOSS, REFUND e ROLLBACK;
- idempotency key com payload divergente;
- máquina de estados e failure codes.

### Integração

Usar PostgreSQL e LocalStack/MiniStack reais em containers para testar migrations, constraints, atomicidade entre wallet/ledger/inbox/outbox, redelivery, publishers concorrentes, retry, DLQ e recuperação após reinício.

### Concorrência e falhas

- a mesma aposta enviada 50 vezes em paralelo;
- duas ou mais operações disputando o saldo;
- wallets diferentes em paralelo;
- pelo menos três processos/instâncias;
- worker morto depois do commit e antes do ack;
- dois publishers sobre a mesma outbox;
- `REFUND`/`ROLLBACK` antes da referência;
- reinício do serviço com consistência final comprovada.

Em todos os testes, verificar:

```text
wallet.balance == saldo reconstruído pelo ledger
```

## 13. Ordem de implementação

1. Configurar Bun, NestJS strict, Docker Compose, PostgreSQL, LocalStack/MiniStack e migrations.
2. Implementar domínio puro: Money, Wallet, WagerTransaction, ledger, estados e eventos.
3. Implementar mapeamentos, constraints, índices, repositories e Unit of Work.
4. Implementar criação de wallet, OPENING, operações financeiras, idempotência e locking.
5. Implementar API, DTOs, consultas, cursor e reconciliação.
6. Implementar SQS, Inbox, ack após commit, retry, DLQ e shutdown.
7. Implementar Outbox, claim concorrente, backoff, eventId e métricas.
8. Implementar worker de referências pendentes e readiness.
9. Executar testes de integração, concorrência, crash recovery e o teste de carga desta entrega (`bun run test:load`).
10. Registrar escolhas, trade-offs, limitações e resultados em `ARCHITECTURE.md`.

## 14. Decisões aprovadas

- O projeto será tratado como desafio técnico.
- A autenticação fica fora da primeira fase.
- O ORM inicial é MikroORM.
- A estratégia de concorrência é optimistic locking com retry limitado.
- Referências pendentes têm TTL total de 15 minutos desde a primeira persistência, com cinco retries em backoff de 30s, 1m, 2m, 4m e 7m.
- O teste de carga fará parte desta entrega.
- Valores monetários serão persistidos como `NUMERIC(19,2)`, com moeda em coluna separada.
- O `payloadHash` usará SHA-256 sobre JSON canônico ordenado, somente com campos de negócio.
- Falhas transitórias do SQS terão cinco tentativas em backoff de 30s, 1m, 2m, 4m e 5m, seguindo para DLQ depois do limite.
- Inbox processado e Outbox publicado terão retenção configurável de 30 dias; pendências não serão removidas automaticamente.
- O cursor do ledger será opaco em Base64URL, baseado em `(createdAt, id)`, com limite padrão 50 e máximo 100.
- O teste de carga usará Compose, PostgreSQL, LocalStack e três instâncias, com aquecimento de 30 segundos, execução de 2 minutos por cenário e métricas de throughput, p50/p95/p99, erros, conflitos de locking e outbox lag.

## 15. Situação das decisões

Não há decisões abertas desta rodada. Novas decisões caras de reverter, que afetem limites ou contratos públicos, devem ser registradas antes da feature correspondente.

Nenhuma escolha pode enfraquecer as invariantes, a atomicidade, a idempotência ou a segurança de concorrência.

## 16. Checklist de aceite

- [ ] README.md original permanece intacto.
- [ ] Nenhum dinheiro usa `number`, `float` ou `double`.
- [ ] Constraints e índices críticos existem no PostgreSQL.
- [ ] Wallet, transação, ledger, Inbox e Outbox são atômicos.
- [ ] Replay idêntico retorna a resposta original.
- [ ] Payload divergente com a mesma key retorna conflito.
- [ ] Duas apostas concorrentes de `80.00` sobre `100.00` deixam saldo `20.00` e um único débito.
- [ ] 50 reenvios paralelos geram um único efeito financeiro.
- [ ] Referências fora de ordem são pendentes, reprocessadas e finalmente rejeitadas com código estável quando necessário.
- [ ] Ack ocorre somente após commit.
- [ ] Publishers e consumidores toleram crash e redelivery.
- [ ] O ledger reconstrói exatamente o saldo materializado.
- [ ] Health, logs, métricas, migrations, shutdown e documentação foram verificados.
