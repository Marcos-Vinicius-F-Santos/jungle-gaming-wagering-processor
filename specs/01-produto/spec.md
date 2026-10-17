# Spec do Produto — Distributed Wagering Processor

Status: Rascunho
Tipo de projeto: Portfólio / desafio técnico
Criado em: 2026-10-15
Última atualização: 2026-10-15 — decisões iniciais aprovadas pelo responsável

## 1. Objetivo

Construir um serviço financeiro distribuído para processar transações de apostas recebidas de múltiplos provedores de jogos.

O produto deve manter a correção financeira quando mensagens forem duplicadas, entregues fora de ordem, processadas simultaneamente ou reentregues depois de falhas. O foco do desafio é demonstrar:

- precisão monetária;
- concorrência segura entre múltiplas instâncias;
- idempotência persistente;
- consistência entre saldo materializado e ledger imutável;
- processamento assíncrono com recuperação após falhas;
- decisões técnicas claras, testáveis e justificadas.

Não é um produto de CRUD genérico: suas garantias financeiras, de concorrência e de mensageria são parte central do resultado esperado.

## 2. Sistema existente

Este é um projeto greenfield. Não há implementação existente a preservar no momento da criação desta spec. O `README.md` do desafio é a fonte original dos requisitos e `ARCHITECTURE.md` é o documento de apoio arquitetural.

## 3. Funcionalidades

As funcionalidades devem ser construídas de forma incremental, nesta ordem geral:

1. **Fundação técnica:** Bun, NestJS, TypeScript strict, Docker Compose, PostgreSQL, migrations e LocalStack/MiniStack.
2. **Domínio financeiro:** `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry`, com invariantes encapsuladas e testes unitários.
3. **Criação e consulta de wallets:** criar wallet com saldo inicial, registrar `OPENING` quando necessário e consultar saldo/versão.
4. **Processamento de transações:** processar `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, incluindo validações, referências e rejeições auditáveis.
5. **Idempotência:** aceitar `Idempotency-Key`, calcular `payloadHash` canônico, retornar replay idêntico e rejeitar conflito de payload.
6. **Ledger e concorrência:** manter saldo e ledger atômicos, impedir saldo negativo e evitar lost updates em múltiplas instâncias.
7. **API HTTP:** expor criação, consultas de wallet/ledger/transações, submissão de transação e reconciliação.
8. **Processamento SQS:** consumir `wager-transactions.fifo`, usar Inbox persistente, reutilizar o mesmo caso de uso da API e fazer ack somente após commit.
9. **Referências fora de ordem:** persistir pendências, reprocessar com backoff e rejeitar de forma auditável ao esgotar o limite/TTL definido.
10. **Transactional Outbox:** gravar eventos na mesma transação financeira e publicá-los depois do commit, com retry e concorrência segura entre publishers.
11. **Observabilidade e saúde:** fornecer logs estruturados, métricas, liveness e readiness.
12. **Verificação:** executar testes unitários, integração real com PostgreSQL/SQS, concorrência, redelivery, crash recovery e reinício.

### Operações de negócio

| Operação | Efeito | Regra essencial |
|---|---|---|
| `BET` | Débito | Rejeitar se o saldo for insuficiente |
| `WIN` | Crédito | Pode referenciar uma `BET` da mesma rodada |
| `LOSS` | Nenhum | Registrar resultado sem mover saldo |
| `REFUND` | Crédito | Reverter uma `BET` processada, uma única vez |
| `ROLLBACK` | Inversão | Reverter uma transação processada, uma única vez |

`REFUND` e `ROLLBACK` exigem referência externa, com mesmo provider, player, wallet, moeda, rodada e valor da operação referenciada. `REFUND` só referencia `BET`; `ROLLBACK` pode referenciar `BET`, `WIN` ou `REFUND`.

### Endpoints previstos

- `POST /wallets`;
- `GET /wallets/:walletId`;
- `GET /wallets/:walletId/ledger?cursor=...&limit=50`;
- `GET /wagering/transactions/:transactionId`;
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`;
- `POST /wagering/transactions`;
- `POST /wallets/:walletId/reconciliation`;
- `GET /health/live`;
- `GET /health/ready`.

## 4. Fora de escopo

- CRUD genérico sem as garantias financeiras descritas nesta spec.
- Autenticação artesanal com tabela própria de usuários e hash de senha. Autenticação é opcional no desafio; se implementada, deve integrar um Identity Provider externo.
- Double-entry bookkeeping como requisito. O ledger de wallet é obrigatório; partidas dobradas são diferencial opcional.
- Reversão parcial de valores; `REFUND` e `ROLLBACK` usam o valor integral da referência.
- Correção silenciosa de divergências na reconciliação.
- Garantir consistência somente por ordenação ou deduplicação do SQS.
- Cache em memória como fonte de verdade para idempotência.
- Testes que substituam completamente PostgreSQL e SQS por mocks.
- Meta de throughput. O teste de carga, embora opcional no enunciado original, fará parte desta entrega e será exposto como `bun run test:load`, com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag registrados.
- Funcionalidades não descritas no `README.md` do desafio.

## 5. Stack técnico e por quê

| Camada | Escolha | Motivo |
|---|---|---|
| Runtime/package manager/test runner | Bun 1.x | Requisito obrigatório do desafio e base para executar a aplicação e os testes |
| Backend | NestJS + TypeScript strict | Requisito obrigatório; TypeScript strict reforça contratos e invariantes no código |
| Banco de dados | PostgreSQL | Requisito obrigatório e responsável por transações, constraints, locks e garantias entre instâncias |
| Mensageria | AWS SQS via LocalStack ou MiniStack | Requisito obrigatório; permite exercitar at-least-once, retry, DLQ e redelivery localmente |
| Orquestração local | Docker Compose | Requisito obrigatório para subir aplicação, PostgreSQL e serviço de filas local |
| ORM | MikroORM, preferencialmente; TypeORM aceito | MikroORM é preferido pelo Unit of Work, Identity Map, `transactional` e `LockMode`; a alternativa precisa ser justificada |
| Migrations | Migrations versionadas e reversíveis | Exigência do desafio e requisito de recuperação segura de schema |
| Autenticação | IdP externo, se implementada | A autenticação não pontua; o desafio não prescreve mecanismo e proíbe autenticação artesanal |

Valores monetários serão recebidos e serializados como strings decimais com duas casas. A representação persistida deve ser exata, usando `NUMERIC`/`DECIMAL` com escala definida ou inteiro em centavos, conforme decisão registrada em `ARCHITECTURE.md`.

## 6. Arquitetura de pastas

A arquitetura de referência está em [`specs/02-arquitetura/arquitetura.md`](../02-arquitetura/arquitetura.md). A organização deve ser por domínio/feature, não por tipo genérico de arquivo:

```text
src/
  domain/
    money/
    wallet/
    wagering/
    ledger/
    messaging/
    events/
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
```

Limites principais:

- o domínio não conhece NestJS, ORM, HTTP ou SQS;
- controllers e consumers chamam os mesmos casos de uso;
- somente o caso de uso, através do agregado `Wallet`, altera saldo;
- repositories, Unit of Work, SQS e observabilidade ficam atrás de portas;
- Inbox, transação, ledger e Outbox participam da mesma transação SQL;
- publishers só trabalham com eventos após o commit.

## 7. Critérios de sucesso

O produto será considerado tecnicamente correto quando:

1. nenhum valor monetário usar `number`, `float` ou `double`;
2. o banco proteger unicidade, imutabilidade e não-negatividade com constraints/índices;
3. saldo e ledger permanecerem consistentes em todas as operações;
4. uma mesma idempotency key com payload igual retornar o resultado original, sem novo efeito;
5. a mesma key com payload diferente resultar em conflito explícito;
6. duas apostas simultâneas de `80.00` sobre saldo `100.00` produzirem uma `PROCESSED`, uma `REJECTED`, saldo `20.00` e um único débito;
7. cinquenta envios paralelos da mesma aposta produzirem um único débito;
8. referências fora de ordem serem persistidas como pendentes e reprocessadas;
9. o consumidor confirmar a mensagem somente depois do commit;
10. um crash depois do commit e antes do ack não duplicar o efeito financeiro;
11. publishers concorrentes não perderem eventos confirmados;
12. reinício e execução com pelo menos três instâncias preservarem as invariantes;
13. o saldo materializado for igual ao saldo reconstruído pelo ledger;
14. logs, métricas, health checks, migrations e documentação permitirem diagnosticar e recuperar o sistema.

## 8. Quem usa IA e como

- [ ] Eu escrevo todo o código.
- [x] IA implementa a partir da minha spec/arquitetura, eu reviso e aprovo.

A IA deve seguir `AGENTS.md` e o ciclo Spec → Arquitetura → Feature → Plano/Tarefas → Implementação → Verificação → Aprovação → Deploy. Não deve inventar requisitos, adiantar tarefas não aprovadas, alterar comportamento de outras features sem aviso ou marcar a tarefa como aprovada sozinha.

## 9. Invariantes e decisões que precisam permanecer visíveis

### Invariantes

- uma wallet por `(playerId, currency)`;
- saldo nunca negativo;
- uma alteração de saldo corresponde a um lançamento imutável;
- uma transação gera no máximo um lançamento por wallet;
- `balanceBefore ± money = balanceAfter`;
- `version` começa em `1` e só muda com o saldo;
- `PROCESSED`, `REJECTED` e `FAILED` são terminais;
- Inbox, saldo, transação, ledger e Outbox são atômicos;
- a unidade de concorrência é `walletId`;
- eventos só saem após o commit.

### Decisões aprovadas

- O projeto será tratado como um desafio técnico.
- A autenticação ficará fora da primeira fase.
- O ORM inicial será o MikroORM.
- A concorrência usará optimistic locking com retry limitado.
- Referências pendentes terão TTL total de 15 minutos desde a primeira persistência, com cinco retries em backoff de 30s, 1m, 2m, 4m e 7m, sem ultrapassar o TTL.
- O teste de carga fará parte da entrega.
- Valores monetários serão persistidos como `NUMERIC(19,2)`, com moeda em coluna separada.
- O `payloadHash` usará SHA-256 sobre JSON canônico ordenado, contendo somente campos de negócio.
- Falhas transitórias do SQS terão cinco tentativas, com backoff de 30s, 1m, 2m, 4m e 5m, e depois seguirão para a DLQ.
- Inbox processado e Outbox publicado terão retenção configurável de 30 dias; registros pendentes não serão removidos automaticamente.
- O ledger usará cursor opaco Base64URL baseado em `(createdAt, id)`, com limite padrão 50 e máximo 100.
- O teste de carga usará Docker Compose, PostgreSQL, LocalStack e três instâncias da aplicação, medindo throughput, p50/p95/p99, erros, conflitos de locking e outbox lag.

### Perguntas abertas — resolvidas

Não há decisões abertas desta rodada. Novas decisões caras de reverter, que afetem limites ou contratos públicos, devem ser registradas antes da feature correspondente.

Decisões caras de reverter, que afetam limites de arquitetura ou contratos públicos, devem usar um registro baseado em `specs/02-arquitetura/DECISAO_TEMPLATE.md`.

## 10. Próximos documentos

Esta Spec do Produto precisa ser revisada e aprovada antes de iniciar a implementação. Depois da aprovação:

1. preencher a arquitetura do projeto, se houver decisões ainda não registradas;
2. criar a Spec da primeira feature em `specs/03-features/`;
3. criar o plano e as tarefas em `specs/04-plano/`;
4. implementar uma tarefa por vez;
5. executar a verificação de convergência antes de qualquer deploy;
6. preparar deploy e rollback executáveis somente após a aprovação do ciclo.

## 11. Perguntas abertas para aprovação

- [x] O projeto será tratado como um desafio técnico.
- [x] A autenticação ficará fora desta primeira fase.
- [x] A escolha inicial será MikroORM.
- [x] A estratégia de concorrência será optimistic locking com retry limitado.
- [x] Referências pendentes terão TTL total de 15 minutos desde a primeira persistência como `PENDING_REFERENCE`, com cinco retries em backoff de 30s, 1m, 2m, 4m e 7m, sem agendar além do TTL.
- [x] O teste de carga fará parte da entrega, com Compose, PostgreSQL, LocalStack, três instâncias, aquecimento de 30 segundos, execução de 2 minutos por cenário e métricas de throughput, p50/p95/p99, erros, conflitos de locking e outbox lag.
