# Spec da Feature — Observabilidade e saúde

Status: Aprovada — sugestões incorporadas; aguardando plano e tarefas  
Projeto: Distributed Wagering Processor  
Onde vive no código: `src/shared/`, `src/interfaces/health/`, adapters de PostgreSQL/SQS e módulos de aplicação  
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature anterior: [`../07-publicar-outbox-transacional/spec.md`](../07-publicar-outbox-transacional/spec.md)

> Esta feature transforma logs, métricas e health checks já exigidos pelo produto em contratos operacionais consistentes, sem alterar as regras financeiras nem criar dependência do domínio em infraestrutura.

## 1. Objetivo

Permitir que operadores identifiquem rapidamente se o processo está vivo, se as dependências necessárias estão acessíveis e em que etapa uma transação, mensagem SQS, referência pendente ou evento da Outbox está falhando.

A feature deve fornecer:

- logs JSON estruturados e seguros;
- correlação consistente entre HTTP, SQS, processamento financeiro, worker de referências e publisher da Outbox;
- métricas mínimas para transações, duplicatas, retries, DLQ, locks, latência, referências e Outbox lag;
- `/health/live` para liveness sem dependências externas;
- `/health/ready` para readiness com diagnóstico de PostgreSQL e SQS;
- timeouts e degradação controlada, sem transformar uma falha do publisher em perda ou rollback financeiro.

## 2. Como funciona hoje

O sistema já possui:

- `StructuredLogger`, que escreve linhas JSON com nível, evento, timestamp e contexto;
- `AppLogger` com métodos `info`, `warn` e `error`;
- `InMemoryMetrics`, que mantém contadores por nome e tags;
- porta `Metrics` usada por SQS, referências pendentes e publisher da Outbox;
- logs de wallet, wagering, Inbox, referências pendentes, SQS e Outbox;
- `SQSClient` configurado para a fila de entrada e para a Outbox;
- PostgreSQL acessível pelo MikroORM e Unit of Work.

Ainda não existe:

- contrato único para `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`;
- sanitização centralizada de chaves sensíveis e payloads grandes;
- métricas de duração e gauges/snapshots de lag;
- controller de liveness/readiness;
- portas de health para PostgreSQL e SQS;
- política explícita para distinguir dependência financeira, consumer SQS e publisher da Outbox;
- testes reais de dependência indisponível, timeout, resposta de health e formato dos logs.

## 3. Requisitos funcionais

### FR-001 — Emitir logs estruturados

Todo log operacional deve ser uma linha JSON válida com, no mínimo, `level`, `event` e `timestamp`. Quando disponíveis, os contextos devem incluir:

- `correlationId`;
- `messageId`;
- `transactionId`;
- `walletId`;
- `providerId`;
- `eventId` para Outbox;
- `attempt` e `outcome` para retries/workers.

O código deve continuar usando a porta `AppLogger`; controllers, consumers e workers não devem depender diretamente de `console.log` ou do logger do Nest para eventos de negócio.

### FR-002 — Propagar correlação

Uma requisição HTTP deve receber ou gerar um `correlationId` e devolvê-lo no header de resposta. O mesmo identificador deve aparecer nos logs gerados durante o processamento daquela requisição.

Uma mensagem SQS deve usar o identificador de correlação presente no envelope quando disponível. Enquanto o contrato de entrada não tiver esse campo, o adapter deve criar uma correlação determinística/segura a partir do `messageId`, sem registrar o corpo completo da mensagem.

O contexto de correlação deve chegar ao caso de uso e aos eventos da Outbox sem alterar o payload de negócio. A publicação deve preservar o `correlationId` já persistido na Outbox.

### FR-003 — Sanitizar logs

Logs não podem conter:

- payload financeiro completo;
- `money.amount` completo quando isso não for necessário para diagnóstico;
- credenciais, tokens, secrets ou receipt handles;
- payload bruto de SQS;
- dados pessoais além dos identificadores operacionais mínimos já previstos.

Erros devem ser normalizados em `errorCode`, `errorName` ou mensagem curta. Stack trace completo pode ser enviado somente por mecanismo de diagnóstico explicitamente configurado, nunca como contexto padrão de negócio.

### FR-004 — Medir transações por status

Instrumentar contadores para transações `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` e falhas transitórias, com tags de operação (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) e origem (`HTTP`, `SQS`, `REFERENCE_WORKER`), sem usar identificadores de alta cardinalidade como tags.

Replay idempotente e conflito de payload devem ser distinguíveis dos demais resultados.

### FR-005 — Medir mensageria e concorrência

Instrumentar, no mínimo:

- mensagens SQS recebidas, processadas, redeliveries, retries e DLQ;
- duplicatas/replays detectados pelo Inbox;
- conflitos de optimistic locking e tentativas esgotadas;
- referências pendentes, resolvidas, incompatíveis e expiradas;
- eventos Outbox selecionados, publicados, reagendados, enviados à DLQ e aguardando intervenção;
- conflitos de claim/lease e possíveis duplicatas de publish.

As métricas devem manter cardinalidade controlada. `eventId`, `transactionId`, `walletId` e `messageId` pertencem a logs, não a tags de métricas.

### FR-006 — Medir latência e lag

A porta de métricas deve suportar observações de duração ou equivalente para:

- latência do caso de uso financeiro;
- latência de consumo SQS;
- duração do reprocessamento de referências;
- duração do publish da Outbox;
- duração das verificações de health.

Também deve registrar snapshots de:

- idade do evento mais antigo pendente na Outbox;
- quantidade de eventos pendentes;
- quantidade/idade de referências pendentes;
- tentativas e tempo de espera de retries.

As unidades devem ser explícitas e consistentes, preferencialmente milissegundos para latência e segundos para idade/lag.

### FR-007 — Expor liveness

`GET /health/live` deve responder sem consultar PostgreSQL, SQS, Inbox, Outbox ou qualquer dependência de rede.

Enquanto o processo aceitar requisições, a resposta deve ser `200 OK` com um corpo pequeno e estável, por exemplo:

```json
{
  "status": "ok"
}
```

Falha de dependência externa não pode transformar liveness em falso negativo.

### FR-008 — Expor readiness

`GET /health/ready` deve verificar as dependências necessárias para o serviço aceitar trabalho novo e responder com diagnóstico seguro por componente.

O contrato deve distinguir:

- serviço pronto;
- serviço não pronto por PostgreSQL indisponível;
- serviço não pronto por SQS de entrada indisponível;
- publisher da Outbox degradado, mantendo o processamento financeiro disponível quando PostgreSQL e entrada continuam saudáveis.

Uma resposta não pronta deve usar `503 Service Unavailable`. O corpo não pode conter credenciais, SQL, endpoints secretos ou stack trace.

Formato mínimo proposto:

```json
{
  "status": "ok",
  "checkedAt": "2026-10-16T00:00:00.000Z",
  "components": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "sqsInput": { "status": "up", "latencyMs": 8 },
    "outboxPublisher": { "status": "up" }
  }
}
```

### FR-009 — Usar portas para health checks

O controller de health não deve acessar MikroORM ou AWS SDK diretamente. Criar portas para:

- verificar conectividade mínima com PostgreSQL;
- verificar acesso às filas SQS relevantes;
- consultar o estado operacional do publisher da Outbox quando habilitado.

Implementações ficam na infraestrutura. O domínio e os casos de uso financeiros não conhecem os controllers de health.

### FR-010 — Limitar timeout e evitar efeito colateral

Cada health check externo deve possuir timeout curto e configurável. Health check não pode:

- abrir transação financeira;
- consumir ou apagar mensagem SQS;
- alterar Inbox, Outbox, wallet, ledger ou transação;
- esperar indefinidamente por uma dependência;
- derrubar o processo por falha de uma verificação.

### FR-011 — Preservar observabilidade existente

A implementação deve manter os eventos de log e métricas já usados por wallet, wagering, Inbox, referências e Outbox, adicionando contexto e medições sem remover diagnósticos existentes.

### FR-012 — Permitir validação operacional

Os contratos devem permitir testes unitários com fakes e testes de integração com PostgreSQL/LocalStack reais. Deve ser possível verificar o formato dos logs, os contadores/latências e o status de cada componente sem substituir completamente as dependências reais nos cenários de integração.

## 4. Regras de negócio e operação

### BR-001 — Liveness é local

Liveness responde sobre o processo, não sobre a saúde das dependências. PostgreSQL ou SQS fora do ar não pode causar falha em `/health/live`.

### BR-002 — Readiness representa capacidade

Readiness deve ser conservadora para as dependências que impedem trabalho novo. PostgreSQL indisponível torna o serviço não pronto. A indisponibilidade do SQS de entrada torna o consumer não pronto.

O publisher da Outbox segue a decisão aprovada na feature anterior: sua indisponibilidade é reportada como degradação e métrica, mas não torna a API financeira indisponível enquanto os eventos continuarem persistidos no PostgreSQL.

### BR-003 — Health é somente leitura

Nenhum endpoint de health pode alterar estado de negócio, avançar retry, publicar evento, consumir mensagem ou criar registro de auditoria financeira.

### BR-004 — Sem alta cardinalidade nas métricas

Identificadores individuais devem aparecer em logs correlacionados. Métricas usam apenas dimensões de baixa cardinalidade, como status, kind, origem, outcome e componente.

### BR-005 — Logs seguros por padrão

O logger deve sanitizar contexto antes de serializar. Adicionar um campo novo a um log não pode permitir acidentalmente o registro de payload bruto, segredo ou receipt handle.

### BR-006 — Métricas não são fonte de verdade

Métricas podem ser perdidas no restart e não substituem PostgreSQL, Inbox, Outbox, ledger ou transações. O sistema deve continuar correto quando o backend de métricas estiver indisponível ou for apenas local.

### BR-007 — Health não mascara erro

Uma dependência indisponível deve produzir status, código e log operacional claros. Não retornar `200` como se tudo estivesse saudável apenas porque o processo está vivo.

## 5. Contratos externos

### `/health/live`

- Método: `GET`;
- autenticação: nenhuma;
- sucesso: `200 OK`;
- sem dependências externas;
- corpo estável e sem dados sensíveis.

### `/health/ready`

- Método: `GET`;
- autenticação: nenhuma;
- sucesso: `200 OK` quando dependências obrigatórias estão disponíveis;
- falha: `503 Service Unavailable`;
- corpo com `status`, `checkedAt` e componentes;
- timeout total limitado para não ocupar conexões indefinidamente.

### Correlação HTTP

- header de entrada proposto: `x-correlation-id`;
- header de saída: `x-correlation-id`;
- quando ausente ou inválido, gerar UUIDv7;
- não aceitar valores excessivamente longos ou contendo caracteres de controle.

O nome exato do header e a política de exposição são sugestões para aprovação; o requisito obrigatório é a correlação segura e estável.

## 6. Métricas propostas

Os nomes abaixo são uma convenção inicial; adapters de produção podem traduzi-los para Prometheus, OpenTelemetry ou outro backend posteriormente:

| Métrica | Tipo | Tags de baixa cardinalidade |
|---|---|---|
| `wager_transactions_total` | counter | `status`, `kind`, `source` |
| `wager_replays_total` | counter | `kind`, `source` |
| `wager_retries_total` | counter | `kind`, `source`, `reason` |
| `sqs_messages_total` | counter | `queue`, `outcome` |
| `sqs_dlq_messages_total` | counter | `queue`, `reason` |
| `lock_conflicts_total` | counter | `aggregate` |
| `reference_pending_total` | counter | `outcome` |
| `outbox_events_total` | counter | `outcome` |
| `outbox_pending_snapshot` | gauge/snapshot | nenhuma ou `component` |
| `outbox_lag_seconds` | gauge/snapshot | nenhuma |
| `processing_duration_ms` | histogram/observation | `operation`, `source` |
| `health_check_duration_ms` | histogram/observation | `component`, `status` |
| `health_checks_total` | counter | `component`, `status` |

Não é obrigatório criar um exporter ou dashboard nesta feature. A porta deve permitir substituir o armazenamento local sem mudar os módulos de negócio.

## 7. Critérios de aceite

### AC-001 — Liveness sem dependências

Dado que PostgreSQL e SQS estejam indisponíveis, quando `/health/live` for chamado, então ele deve responder `200` dentro do timeout local e sem abrir conexão externa.

### AC-002 — Readiness saudável

Dado que PostgreSQL e as filas SQS necessárias estejam acessíveis, quando `/health/ready` for chamado, então deve responder `200` com componentes `up` e latências não negativas.

### AC-003 — Readiness com PostgreSQL indisponível

Dado que PostgreSQL não responda, quando `/health/ready` for chamado, então deve responder `503`, indicar `postgres` como `down`/`timeout` e não expor SQL ou credenciais.

### AC-004 — Readiness com SQS de entrada indisponível

Dado que o SQS de entrada não responda, quando `/health/ready` for chamado, então deve responder `503`, indicar o componente afetado e manter `/health/live` funcionando.

### AC-005 — Publisher degradado

Dado que PostgreSQL e SQS de entrada estejam saudáveis, mas o SQS de eventos esteja indisponível, quando `/health/ready` for chamado, então a resposta deve seguir a política aprovada: processamento financeiro permanece disponível, publisher aparece como `degraded` e o outbox lag é mensurável.

### AC-006 — Correlação HTTP

Dado um request HTTP com `x-correlation-id` válido, quando o fluxo terminar, então o mesmo valor deve aparecer no header de resposta e nos logs do fluxo. Sem header válido, o sistema deve gerar um UUIDv7 seguro.

### AC-007 — Correlação SQS/Outbox

Dado um processamento iniciado por SQS ou worker da Outbox, quando logs e publicação forem produzidos, então o `correlationId`, `messageId`/`eventId` e identificadores operacionais disponíveis devem ser rastreáveis sem registrar o corpo completo.

### AC-008 — Logs seguros

Dado qualquer sucesso, replay, retry, conflito, DLQ ou erro de health, quando a linha de log for serializada, então ela deve ser JSON válido e não conter secrets, receipt handles, payload bruto ou valores financeiros completos desnecessários.

### AC-009 — Métricas de resultado

Dado um conjunto de transações processadas, rejeitadas, pendentes, replays e retries, quando o snapshot de métricas for consultado no adapter de teste, então os contadores devem distinguir os outcomes sem tags de alta cardinalidade.

### AC-010 — Métricas de workers

Dado um ciclo de referência pendente e um ciclo de publisher Outbox com sucesso, retry e DLQ, quando as métricas forem consultadas, então devem existir contadores de outcome, duração e lag/idade.

### AC-011 — Timeout de health

Dado que uma dependência não responda, quando o health check for executado, então ele deve terminar no timeout configurado, registrar a falha e não bloquear indefinidamente o event loop ou conexões da aplicação.

### AC-012 — Health sem efeitos colaterais

Dado qualquer chamada a `/health/live` ou `/health/ready`, quando o banco e o broker forem consultados, então não devem ser criados, alterados ou removidos registros de wallet, ledger, transação, Inbox ou Outbox, nem mensagens SQS consumidas.

### AC-013 — Regressão dos fluxos existentes

Dado que a instrumentação e os health checks estejam habilitados, quando HTTP, SQS de entrada, referências pendentes e publisher da Outbox forem executados, então os efeitos financeiros, eventos, retries e contratos já aprovados devem permanecer iguais.

## 8. Casos de erro e edge cases

- header de correlação ausente → gerar UUIDv7;
- header vazio, longo demais ou com controle → ignorar e gerar novo valor seguro;
- envelope SQS sem `correlationId` → correlacionar por `messageId` conforme decisão aprovada;
- log com objeto circular ou valor não serializável → sanitizar sem derrubar o fluxo financeiro;
- erro sem classe/código → usar código operacional estável e mensagem curta;
- PostgreSQL lento → timeout e readiness não pronto, sem abrir transação de negócio;
- SQS de entrada lento → timeout e readiness não pronto;
- SQS de eventos lento → publisher degradado, Outbox continua persistida;
- timeout simultâneo em duas dependências → relatar componentes individualmente e preservar `/health/live`;
- health chamado em alta frequência → não criar métrica com `requestId`, IP ou URL dinâmica;
- retry de publisher → incrementar métricas sem registrar payload completo;
- retry de referência → preservar contadores existentes e não reiniciar TTL;
- evento `LOSS` sem mudança de saldo → métricas de transação sem métrica de mudança de saldo;
- replay idempotente → contabilizar replay sem contabilizar novo efeito financeiro;
- publisher desligado → health reporta componente `disabled`/`not_configured` sem impedir testes financeiros;
- metrics adapter indisponível → log seguro e fluxo de negócio continua, quando tecnicamente possível;
- shutdown durante health check → terminar a verificação em voo e encerrar sem iniciar nova consulta.

## 9. Fora de escopo desta feature

- Alterar regras financeiras, idempotência, Inbox, Outbox, SQS, wallet ou ledger.
- Dashboard, alertas, OpenTelemetry completo, tracing distribuído e APM proprietário.
- Exporter Prometheus obrigatório ou persistência de métricas em banco.
- Autenticação dos endpoints de health, que permanecem públicos conforme arquitetura.
- SLO/SLA, autoscaling, circuit breaker ou service mesh.
- Limpeza, retenção ou reconciliação de dados de negócio.
- Alteração do `README.md`.

## 10. Suposições, perguntas abertas e sugestões

### Decisões já definidas pelo produto e pela arquitetura

- [x] Logs devem ser estruturados em JSON e não conter payload financeiro completo ou dados sensíveis.
- [x] Métricas mínimas cobrem status, duplicatas, retries, DLQ, locks, outbox lag, latência e referências pendentes/expiradas.
- [x] `/health/live` e `/health/ready` são endpoints separados e sem autenticação.
- [x] PostgreSQL e SQS fazem parte da verificação de integração real.
- [x] A indisponibilidade do publisher da Outbox não deve desfazer a confirmação financeira nem tornar a API indisponível quando a persistência continua saudável.
- [x] OpenTelemetry e dashboard são opcionais.

### Sugestões para aprovação antes do plano

- [x] **Correlação HTTP:** aceitar `x-correlation-id`, validar até 100 caracteres sem controle e gerar UUIDv7 quando ausente/inválido; devolver o valor no mesmo header.
- [x] **Correlação SQS:** usar `correlationId` do envelope futuro; enquanto o contrato não o possuir, usar `messageId` como correlação operacional sem alterar o payload de negócio.
- [x] **Contrato de métricas:** estender `Metrics` com `observe(name, value, tags?)` e `set(name, value, tags?)`, mantendo `increment`; `InMemoryMetrics` armazenará snapshots para testes.
- [x] **Readiness:** PostgreSQL e SQS de entrada são obrigatórios para `200`; SQS de eventos aparece como `degraded` e não bloqueia a API financeira.
- [x] **Health SQS:** verificar a existência/acessibilidade das filas com operação read-only (`GetQueueAttributes`), sem `ReceiveMessage`, `DeleteMessage` ou alteração de visibilidade.
- [x] **Timeouts:** usar 500ms por dependência e timeout total de 1s, configuráveis por ambiente e cobertos por testes.
- [x] **Métricas externas:** manter exporter fora desta feature e preservar uma porta substituível, evitando acoplamento a Prometheus/OpenTelemetry.

## 11. Definition of Done desta feature

- [x] Esta Spec foi revisada e aprovada.
- [x] Política de correlação HTTP/SQS foi aprovada.
- [x] Contrato de métricas de contador, duração e snapshot foi aprovado.
- [ ] `/health/live` não depende de PostgreSQL ou SQS.
- [ ] `/health/ready` informa PostgreSQL, SQS de entrada e estado do publisher.
- [ ] Readiness possui timeout e resposta segura por componente.
- [ ] Logs são JSON, correlacionados e sanitizados.
- [ ] Métricas cobrem transações, replays, retries, DLQ, locks, referências, Outbox e latência.
- [ ] Health checks não têm efeitos colaterais.
- [ ] Testes unitários e de integração reais cobrem dependências saudáveis, indisponíveis e lentas.
- [ ] Regressão HTTP, SQS, referências e Outbox permanece passando.
- [x] O plano e as tarefas só serão criados depois da aprovação formal desta Spec.
