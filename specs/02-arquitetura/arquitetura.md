# Arquitetura — Distributed Wagering Processor

Status: Rascunho
Última atualização: 2026-10-15
Spec do produto: [`../01-produto/spec.md`](../01-produto/spec.md)
Fonte original de requisitos: [`../../README.md`](../../README.md)

## 1. Visão geral do sistema

O sistema recebe operações de apostas por HTTP e SQS, executa um único caso de uso financeiro, persiste o resultado de forma atômica no PostgreSQL e publica eventos por meio de uma Transactional Outbox.

```text
                 ┌──────────────────────┐
                 │ Provedor / cliente    │
                 └──────────┬───────────┘
                            │ HTTP
                    ┌───────▼────────┐
                    │ NestJS API      │
                    └───────┬────────┘
                            │
                 ┌──────────▼──────────┐
                 │ Caso de uso único   │
                 │ ProcessWager...     │
                 └──────────┬──────────┘
                            │ transação SQL
                    ┌───────▼────────┐
                    │ PostgreSQL      │
                    │ wallet/ledger   │
                    │ tx/inbox/outbox │
                    └───────┬────────┘
                            │ após commit
                    ┌───────▼────────┐
                    │ Outbox worker   │──────► eventos de integração
                    └────────────────┘

                 SQS request ─► Consumer ─► mesmo caso de uso
```

A unidade de concorrência é `walletId`. Wallets diferentes devem continuar processando em paralelo; operações da mesma wallet devem ser protegidas por optimistic locking com retry limitado.

## 2. Princípio de organização: por domínio/feature

O código será organizado por domínio/feature, não por uma pasta global de controllers, services ou repositories. Cada módulo pode ter suas próprias camadas internas, mantendo as dependências apontadas para dentro.

```text
src/
  app/
    app.module.ts
    config/
  modules/
    wallets/
      domain/
      application/
      infrastructure/
      http/
    wagering/
      domain/
      application/
      infrastructure/
      http/
    reconciliation/
      application/
      http/
    messaging/
      inbox/
      outbox/
      infrastructure/
    health/
      http/
  shared/
    domain/
    application/
    infrastructure/
```

### 2.1 Responsabilidade dos módulos

| Módulo | Responsabilidade |
|---|---|
| `wallets` | Aggregate `Wallet`, abertura, saldo, versão e consultas de wallet/ledger |
| `wagering` | `WagerTransaction`, regras de BET/WIN/LOSS/REFUND/ROLLBACK e processamento idempotente |
| `reconciliation` | Reconstrução do saldo pelo ledger e sinalização de divergências |
| `messaging/inbox` | Deduplicação persistente de mensagens SQS e estado de processamento |
| `messaging/outbox` | Registro, claim, publicação, retry e métricas dos eventos |
| `health` | Liveness e readiness sem autenticação |
| `shared` | Abstrações realmente compartilhadas, sem virar depósito de regras de negócio |

### 2.2 Limites entre camadas

- `domain` não importa NestJS, ORM, decorators, HTTP ou SQS.
- `application` coordena casos de uso e transações por meio de portas.
- `infrastructure` implementa portas para PostgreSQL, MikroORM, SQS e observabilidade.
- `http` valida transporte e traduz resultados; nunca altera saldo diretamente.
- O consumer SQS chama o mesmo caso de uso usado pela API.
- O publisher da Outbox só publica registros persistidos depois do commit.
- Nenhuma feature acessa diretamente tabelas pertencentes a outra feature; usar portas ou casos de uso explícitos.

## 3. Componentes e portas

### Domínio

- `Money`: value object imutável, decimal exato e moeda explícita.
- `Wallet`: aggregate root, saldo, moeda e versão; `debit` e `credit` preservam invariantes.
- `WagerTransaction`: operação do provedor, estado, referência, hash e failure code.
- `WalletLedgerEntry`: lançamento imutável com saldo anterior/posterior.
- `InboxMessage`: entrega persistida e estado de processamento.
- `OutboxMessage`: evento pendente, tentativas, backoff e publicação.
- Subclasses concretas de `IntegrationEvent` para os eventos exigidos.

### Portas da aplicação

- `WalletRepository`;
- `WagerTransactionRepository`;
- `LedgerRepository`;
- `InboxRepository`;
- `OutboxRepository`;
- `UnitOfWork`/`TransactionManager`;
- `MessagePublisher` e `MessageConsumer`;
- `PayloadHasher` para JSON canônico;
- `Clock`, `IdGenerator`, `Logger` e `Metrics`.

O caso de uso `ProcessWagerTransaction` deve ser a única entrada de aplicação para aplicar uma transação financeira, tanto para HTTP quanto para SQS.

## 4. Modelo de dados e invariantes

### `wallets`

- `id` como chave primária;
- `player_id` e `currency`;
- saldo em representação exata;
- `version`, `created_at` e `updated_at`;
- `UNIQUE(player_id, currency)`;
- `CHECK` impedindo saldo negativo.

### `wager_transactions`

- identificador interno e `(provider_id, external_transaction_id)`;
- `idempotency_key` e `payload_hash`;
- provider, player, wallet, round e game;
- kind, valor, referência externa;
- status, failure code, timestamps e resultado necessário para replay;
- unicidade do identificador externo e da key no escopo escolhido.

### `wallet_ledger_entries`

- wallet, transaction, direção, valor, `balance_before`, `balance_after` e timestamp;
- `UNIQUE(wallet_id, transaction_id)`;
- nenhuma operação de update/delete exposta;
- validação de `balanceBefore ± money = balanceAfter` no domínio e constraints básicas no banco.

### `inbox_messages`

- `consumer_name`, `message_id`, `payload_hash`, `received_at` e `processed_at`;
- `UNIQUE(consumer_name, message_id)`.

### `outbox_messages`

- `event_id`, `aggregate_id`, `event_type`, versão e payload JSONB;
- `attempts`, `next_attempt_at`, `published_at` e timestamps;
- índice para selecionar mensagens pendentes/due;
- claim concorrente com `FOR UPDATE SKIP LOCKED` ou mecanismo equivalente.

Migrations devem ser versionadas e reversíveis. Nenhum schema deve ser alterado diretamente sem migration.

## 5. Transação financeira e optimistic locking

O fluxo de uma operação é:

1. Abrir uma transação SQL.
2. Se a origem for SQS, registrar ou localizar o Inbox por `(consumerName, messageId)`.
3. Canonicalizar o payload e calcular o `payloadHash` sem incluir header ou metadados de transporte.
4. Resolver a idempotency key:
   - key e hash iguais: retornar o resultado persistido sem novo efeito;
   - key igual e hash diferente: conflito, sem efeito financeiro.
5. Inserir ou carregar `WagerTransaction` em `PENDING`.
6. Carregar a wallet e sua versão.
7. Validar referência, player, wallet, moeda, rodada, valor e regra do kind.
8. Aplicar `debit`/`credit` no agregado.
9. Persistir saldo, versão, transação, no máximo um ledger e os eventos da Outbox.
10. Marcar Inbox como processado, quando aplicável.
11. Commitar.
12. Responder HTTP ou fazer ack SQS somente depois do commit.

O update otimista deve ser condicionado pela versão anterior, por exemplo `WHERE id = ? AND version = ?`, e verificar exatamente uma linha afetada. Conflito de versão deve gerar retry limitado, recarregando o estado da wallet e repetindo a operação de forma segura. Ao esgotar retries, emitir diagnóstico/métrica e classificar a falha sem criar lançamento duplicado.

Não existe lock global. O retry não pode contornar constraints nem repetir uma operação que já foi confirmada.

## 6. Estados e regras de transação

```text
PENDING ───────────────► PROCESSED
   │  \                 ▲
   │   └──────────────► REJECTED
   │
   ├──────────────────► PENDING_REFERENCE ──► PROCESSED
   │                                      \──► REJECTED
   └──────────────────► FAILED
```

- `PROCESSED`, `REJECTED` e `FAILED` são terminais.
- `LOSS` pode ser `PROCESSED` sem gerar ledger.
- `REFUND` e `ROLLBACK` aguardam referência quando ela ainda não existe.
- `OPENING` só é criado internamente na abertura de wallet.
- saldo insuficiente em `BET` usa `INSUFFICIENT_FUNDS`.
- reversão que produziria saldo negativo usa `REVERSAL_NEGATIVE_BALANCE`.
- referência ausente após TTL usa `REFERENCE_NOT_FOUND`.

## 7. Referências fora de ordem

Ao não encontrar a referência:

1. persistir `PENDING_REFERENCE`;
2. gravar/publicar `WagerTransactionPendingReference` pela Outbox;
3. agendar o worker com backoff;
4. reprocessar o mesmo caso de uso sem criar uma nova operação;
5. ao expirar, mudar para `REJECTED` com `REFERENCE_NOT_FOUND` e publicar `WagerTransactionRejected`.

Política aprovada:

- TTL total de 15 minutos desde a primeira persistência como pendência;
- cinco retries em `30s`, `1m`, `2m`, `4m` e `7m`;
- nenhum agendamento pode ultrapassar o TTL;
- redelivery do broker não reinicia o TTL;
- expiração é terminal e auditável.

## 8. HTTP, SQS e Outbox

### HTTP

Controllers validam DTOs, exigem `Idempotency-Key` na submissão e chamam o caso de uso. O mapeamento deve distinguir payload inválido, conflito, rejeição de negócio, pendência, falha transitória e falha permanente.

### SQS

Filas locais:

- `wager-transactions.fifo`;
- `wager-transactions-dlq.fifo`.

O consumer deve:

- validar o envelope;
- deduplicar pelo Inbox persistente;
- reutilizar `ProcessWagerTransaction`;
- fazer ack somente depois do commit;
- dar ack em rejeições de negócio persistidas;
- deixar falhas transitórias para retry/backoff;
- enviar falhas permanentes à DLQ após o limite;
- concluir mensagens ou devolver visibilidade durante `SIGTERM`.

### Outbox

Os eventos mínimos são:

- `WagerTransactionProcessed`;
- `WagerTransactionRejected`;
- `WalletBalanceChanged`, somente quando o saldo muda;
- `WagerTransactionPendingReference`.

O publisher pode publicar uma mensagem e cair antes de marcar `published_at`; por isso consumidores de eventos precisam ser idempotentes por `eventId`. A Outbox evita perda depois do commit, mas não promete exatamente uma entrega.

## 9. Observabilidade e health

Logs são JSON estruturado e podem conter `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem payload financeiro completo ou dados sensíveis.

Métricas mínimas:

- transações por status;
- duplicatas detectadas;
- retries;
- mensagens na DLQ;
- conflitos de optimistic locking;
- outbox lag;
- latência de processamento;
- referências pendentes e expiradas.

Endpoints:

- `/health/live`: processo vivo;
- `/health/ready`: PostgreSQL e SQS alcançáveis.

Ambos permanecem sem autenticação.

## 10. Testes e verificação

### Unitários

Cobrir Money, Wallet, estados, regras de BET/WIN/LOSS/REFUND/ROLLBACK, moedas incompatíveis, payload hash divergente e invariantes do ledger.

### Integração

Usar PostgreSQL e LocalStack/MiniStack reais para migrations, constraints, atomicidade, Inbox, Outbox, retry, DLQ e reinício.

### Concorrência e recuperação

Verificar 50 reenvios paralelos, disputa de saldo, wallets distintas em paralelo, pelo menos três instâncias, crash entre commit e ack, dois publishers e referências fora de ordem. Todo teste deve terminar validando:

```text
wallet.balance == saldo reconstruído pelo ledger
```

### Teste de carga

Fará parte desta entrega e será executado por `bun run test:load`. O relatório deve registrar ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag. Não há meta de RPS definida; a honestidade e a qualidade do experimento são o critério.

## 11. Decisões grandes já tomadas

- Bun 1.x, TypeScript strict e NestJS.
- PostgreSQL e Docker Compose.
- SQS via LocalStack/MiniStack.
- MikroORM como ORM inicial.
- Money decimal exato e serializado como string.
- Optimistic locking por wallet com retry limitado.
- Inbox e Outbox persistentes.
- Autenticação fora da primeira fase, com ponto de extensão futuro.
- TTL de referências pendentes de 15 minutos e backoff aprovado.
- Teste de carga incluído na entrega.

## 12. Decisões aprovadas para as próximas features

As decisões abertas desta rodada foram aprovadas com os seguintes parâmetros:

- valores monetários persistidos como `NUMERIC(19,2)`, com moeda em coluna separada;
- `payloadHash` calculado com SHA-256 sobre JSON canônico ordenado, contendo somente campos de negócio;
- falhas transitórias do SQS com cinco tentativas e backoff de `30s`, `1m`, `2m`, `4m` e `5m`, seguindo para DLQ depois do limite;
- Inbox processado e Outbox publicado retidos por 30 dias, com prazo configurável; registros pendentes não são removidos automaticamente;
- cursor opaco Base64URL contendo a última combinação `(createdAt, id)`, ordenação decrescente, limite padrão 50 e máximo 100;
- teste de carga executado com Docker Compose, PostgreSQL, LocalStack e três instâncias da aplicação, com aquecimento de 30 segundos, execução de 2 minutos por cenário e registro de throughput, p50/p95/p99, erros, conflitos de locking e outbox lag.

Não há decisões abertas desta rodada. Qualquer nova decisão cara de reverter, que altere limites ou contratos públicos, deve usar um registro baseado em `DECISAO_TEMPLATE.md` antes da feature correspondente.

## 13. Limites que não devem ser cruzados

- UI/API não acessa banco diretamente.
- Domínio não depende de infraestrutura.
- Nenhum adapter cria regra financeira paralela ao caso de uso.
- Nenhum evento é publicado dentro do fluxo antes do commit.
- Nenhum retry reinicia TTL ou produz segundo ledger para a mesma transação.
- Nenhuma rejeição apaga a transação ou o histórico.
- Nenhum segredo é hardcoded ou commitado.
- Nenhuma migration altera dados sem caminho de volta documentado.

## 14. O que fica de fora por agora

- autenticação e autorização de usuário;
- double-entry bookkeeping;
- reversões parciais;
- cache distribuído como mecanismo de consistência;
- features não descritas no README ou na Spec do Produto;
- otimizações de throughput que não sejam necessárias para os testes e invariantes atuais.
