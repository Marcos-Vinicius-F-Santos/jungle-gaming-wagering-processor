# Plano de Implementação — Observabilidade e saúde

Spec relacionada: [`../../03-features/08-observabilidade-saude/spec.md`](../../03-features/08-observabilidade-saude/spec.md)  
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto relacionado: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Feature anterior: [`../07-publicar-outbox-transacional/plano.md`](../07-publicar-outbox-transacional/plano.md)  
Status: Implementação concluída — aguardando aprovação final

## 1. Resumo técnico

Implementar uma camada de observabilidade operacional que preserve os fluxos financeiros atuais e torne cada processamento rastreável, mensurável e diagnosticável. A solução terá quatro partes integradas:

1. logger estruturado com sanitização centralizada;
2. correlação HTTP, SQS e Outbox usando contexto seguro;
3. porta de métricas com contadores, observações e snapshots de baixa cardinalidade;
4. endpoints públicos e separados de liveness/readiness, com health checks somente leitura e timeouts limitados.

O readiness considerará PostgreSQL e SQS de entrada como dependências obrigatórias. A fila de eventos da Outbox será reportada como `up`, `degraded` ou `disabled`, sem bloquear a capacidade financeira quando a persistência e a entrada estiverem saudáveis. O publisher continuará fora da Unit of Work financeira.

## 2. Decisões aplicadas

- Correlação HTTP usa `x-correlation-id` na entrada e na resposta.
- Valores ausentes, vazios, maiores que 100 caracteres ou com caracteres de controle serão substituídos por UUIDv7.
- O contexto HTTP será propagado até logs, caso de uso e eventos da Outbox sem alterar o payload de negócio.
- Mensagens SQS usarão `correlationId` do envelope quando ele existir; no contrato atual, `messageId` será a correlação operacional segura.
- `Metrics` manterá `increment` e ganhará `observe` e `set`.
- `InMemoryMetrics` manterá snapshots testáveis de contadores, observações e gauges.
- PostgreSQL e SQS de entrada são obrigatórios para readiness `200`.
- SQS de eventos será verificado, mas sua falha produzirá `degraded` e não `503` enquanto as dependências financeiras estiverem saudáveis.
- Health de SQS usará somente `GetQueueAttributes`; não haverá receive, delete ou alteração de visibilidade.
- Cada dependência terá timeout padrão de 500 ms e o health agregado terá timeout total de 1 s, ambos configuráveis.
- Exporter Prometheus, OpenTelemetry completo, dashboard e alertas permanecem fora do escopo.
- O `README.md` não será alterado.

## 3. Baseline e impacto

O código já possui `StructuredLogger`, `AppLogger`, `InMemoryMetrics`, a porta `Metrics`, consumidores SQS, worker de referências, publisher da Outbox e configuração MikroORM/SQS. Ainda não há contexto de correlação compartilhado, sanitização central, observações/gauges de métricas, portas de health ou controllers de liveness/readiness.

| Componente | Mudança planejada | Risco |
|---|---|---|
| `src/shared/application/ports/logger.port.ts` e logging | Formalizar contexto seguro e sanitização antes da serialização | Médio; não perder eventos atuais nem registrar dados financeiros sensíveis |
| `src/shared/application/ports/metrics.port.ts` e `InMemoryMetrics` | Adicionar `observe`/`set` e snapshots sem quebrar `increment` | Médio; tags precisam manter cardinalidade controlada |
| `src/shared/` | Criar contexto de correlação e middleware/interceptor | Alto; contexto não pode vazar entre requests ou mensagens concorrentes |
| `src/modules/wagering/` | Instrumentar resultados, duração, origem e correlação | Alto; efeitos financeiros e decisões de domínio não podem mudar |
| `src/modules/messaging/sqs/` | Propagar correlação, métricas e adapter read-only de health | Alto; health não pode consumir nem alterar mensagens |
| `src/modules/messaging/outbox/` | Instrumentar publish, retry, DLQ, lag e estado do publisher | Alto; indisponibilidade do publisher não pode bloquear a API financeira |
| `src/interfaces/health/` | Criar portas, serviço agregado e controllers | Alto; readiness deve distinguir dependências obrigatórias e degradadas |
| `src/infrastructure/database/` | Implementar ping/readiness PostgreSQL via porta | Médio; consulta deve ser mínima, somente leitura e limitada por timeout |
| `.env.example` e configuração | Adicionar timeouts e parâmetros de health/correlação | Baixo; defaults devem manter o comportamento atual |
| `test/unit/` e `test/integration/` | Cobrir contratos, dependências saudáveis/lentas/indisponíveis e regressão | Alto; integração real deve validar PostgreSQL e LocalStack |

## 4. Contratos e desenho técnico

### Logger e sanitização

O `AppLogger` continuará sendo a dependência dos módulos. O adapter estruturado emitirá uma linha JSON contendo `level`, `event` e `timestamp`, acrescida somente de contexto sanitizado. A sanitização deverá:

- permitir os campos operacionais previstos (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `eventId`, `attempt`, `outcome` e códigos curtos);
- remover ou mascarar chaves de segredo, token, autorização, senha e receipt handle;
- omitir payload bruto, `data` financeiro completo, corpo SQS e stack trace padrão;
- limitar mensagens e valores textuais para evitar linhas excessivas;
- tratar objetos circulares ou não serializáveis sem lançar erro no fluxo de negócio.

### Contexto de correlação

Criar uma porta/serviço de contexto baseada em `AsyncLocalStorage`, com operação para executar um callback dentro de um `correlationId` e leitura do contexto corrente. Um middleware HTTP validará o header, criará UUIDv7 quando necessário e registrará o mesmo valor na resposta. O consumidor SQS criará um contexto por mensagem, usando `correlationId` do envelope futuro ou `messageId` no envelope atual. O publisher da Outbox usará o `correlationId` persistido no evento.

O contexto não será colocado como tag de métrica e não deverá alterar o comando financeiro, o envelope já aprovado ou os dados de negócio.

### Métricas

Estender `Metrics` com:

```ts
increment(name: string, tags?: MetricTags): void;
observe(name: string, value: number, tags?: MetricTags): void;
set(name: string, value: number, tags?: MetricTags): void;
```

`InMemoryMetrics` deverá guardar contadores, observações e valores atuais por chave de tags ordenadas. A API de snapshot será adequada para testes e não será usada como fonte de verdade. Os nomes definidos na Spec serão usados pelos módulos, com tags somente de baixa cardinalidade.

### Health

Criar portas de aplicação para:

- `PostgresHealthCheck`: consulta mínima de conectividade;
- `SqsHealthCheck`: consulta read-only de atributos para fila de entrada e fila de eventos;
- `OutboxPublisherHealth`: estado habilitado/desabilitado/degradado do publisher e, quando disponível, timestamp/lag operacional.

O serviço de health executará verificações com timeout individual e total, normalizará cada resultado para `up`, `down`, `timeout`, `degraded` ou `disabled`, e construirá a resposta sem expor detalhes de infraestrutura. O controller dependerá apenas desse serviço e não conhecerá MikroORM, `SQSClient` ou SDK AWS.

`GET /health/live` será local e estável. `GET /health/ready` verificará PostgreSQL, SQS de entrada e o componente Outbox, retornando `503` somente quando uma dependência obrigatória estiver `down` ou `timeout`.

### Wiring

O módulo de health será carregado pelo `AppModule`. Adapters de PostgreSQL e SQS receberão as configurações existentes por portas. O health de SQS poderá consultar as URLs já configuradas sem habilitar consumer ou publisher. Os providers de logger e métricas serão únicos por aplicação para que os módulos preservem os eventos existentes.

## 5. Sequência de implementação

### Fase 1 — Contratos e baseline

1. Confirmar o baseline de testes e mapear os pontos de logging/métricas já existentes.
2. Estender as portas de logger/métricas e criar o contexto de correlação.
3. Definir portas de health e configuração validada.

### Fase 2 — Logging e correlação

1. Implementar sanitização central e preservar JSON estruturado.
2. Adicionar middleware HTTP e header de resposta.
3. Propagar contexto por SQS, casos de uso e Outbox.
4. Normalizar códigos e contextos dos erros sem registrar payload bruto.

### Fase 3 — Métricas

1. Implementar observações e snapshots no adapter em memória.
2. Instrumentar transações, replays, retries, locks e referências.
3. Instrumentar SQS, Outbox, DLQ, duração e lag.

### Fase 4 — Health

1. Implementar adapters read-only de PostgreSQL e SQS.
2. Expor estado operacional do publisher da Outbox.
3. Implementar agregação, timeout, classificação e controllers.
4. Integrar configurações e providers no bootstrap.

### Fase 5 — Verificação

1. Cobrir logger, correlação, métricas e health com testes unitários.
2. Validar liveness/readiness com PostgreSQL e LocalStack reais.
3. Validar timeout, indisponibilidade, degradação e ausência de efeitos colaterais.
4. Executar regressão completa e preparar evidências sem aprovar automaticamente a feature.

## 6. Riscos e mitigação

| Risco | Severidade | Mitigação |
|---|---:|---|
| Contexto de uma mensagem vazar para outra | Crítica | `AsyncLocalStorage`, escopo por callback e testes concorrentes |
| Log registrar segredo ou payload financeiro | Crítica | Sanitizador central antes de `JSON.stringify`, allowlist operacional e testes de conteúdo |
| Tags de alta cardinalidade degradarem métricas | Alta | Validar tags permitidas e manter IDs somente em logs |
| Health consumir ou apagar SQS | Crítica | Adapter exclusivo com `GetQueueAttributes` e testes com comandos proibidos |
| Health bloquear conexões indefinidamente | Alta | Timeout por dependência e deadline agregado de 1 s |
| Publisher Outbox derrubar API financeira | Crítica | Estado `degraded`, readiness obrigatório separado e teste com eventos pendentes |
| Instrumentação alterar transação | Alta | Métricas/logs best-effort e testes de regressão/atomicidade |
| Métrica em memória virar fonte de verdade | Média | Interface substituível, snapshots somente para diagnóstico e nenhum fluxo depende do valor |
| Health expor detalhes internos | Alta | DTO seguro, códigos estáveis e ausência de SQL, URLs secretas ou stack traces |

## 7. Critérios de aprovação do plano

- Cada tarefa referencia FRs/ACs e possui verificação objetiva.
- A implementação não altera regras financeiras nem o envelope de negócio.
- Logs permanecem JSON e são sanitizados antes da serialização.
- Correlação HTTP, SQS e Outbox é rastreável sem virar tag de métrica.
- `Metrics` mantém compatibilidade com `increment` e suporta observações/snapshots.
- Liveness não consulta rede, PostgreSQL ou SQS.
- Readiness distingue PostgreSQL, SQS de entrada e publisher Outbox.
- SQS health é somente leitura e usa `GetQueueAttributes`.
- Timeouts individuais e total são configuráveis e testados.
- Testes de integração usam PostgreSQL/LocalStack reais quando aplicável.
- Fluxos existentes de HTTP, SQS, referências e Outbox continuam passando.
- O `README.md` não é alterado e a entrega permanece aguardando aprovação final.

## 8. Evidências da implementação

### Baseline da T-001

- `bun run typecheck` passou.
- `bun test test/unit` passou com 71 testes, 0 falhas e 211 expectativas.
- PostgreSQL e LocalStack foram iniciados; a migration `Migration20261016020000` foi aplicada no banco local. Após limpar somente a fila local `wager-transactions.fifo`, `bun test` passou com 113 testes, 0 falhas e 349 expectativas.
- O baseline confirmou providers duplicados de logger/métricas em módulos existentes, o uso atual de `console.log`/`Logger` fora da porta em alguns workers, métricas predominantemente baseadas em `increment` e ausência de endpoints/portas de health.
- T-002 adicionou `observe` e `set` como capacidades opcionais da porta `Metrics`, preservando adapters legados durante a migração; o armazenamento das observações e gauges ficará para T-009.
- T-003 criou contratos de health independentes de infraestrutura para PostgreSQL, filas SQS e estado do publisher da Outbox, com status operacionais seguros.
- T-004 criou `CorrelationContext` com `AsyncLocalStorage`, validação de header e geração de UUIDv7; a propagação nos transports será feita nas tarefas T-006 e T-007.
- T-005 adicionou sanitização central ao `StructuredLogger`, removendo chaves sensíveis/payloads, limitando valores e normalizando erros/objetos circulares antes do JSON.
- T-006 registrou o `HttpCorrelationMiddleware` no `AppModule`, validando/gerando `x-correlation-id`, devolvendo-o na resposta e executando o request dentro do contexto assíncrono.
- T-007 tornou o contexto global, adicionou correlação opcional ao envelope SQS sem mudar o comando financeiro, isolou o processamento do consumer/Outbox e fez o logger incluir o contexto ativo.
- T-008 substituiu o logger direto do Nest no worker de referências pela porta `AppLogger` e normalizou falhas em `errorCode` curto.
- T-009 estendeu `InMemoryMetrics` com observações e gauges, mantendo o snapshot de contadores e retornando cópias imutáveis para testes.
- T-010 instrumentou resultados financeiros, replays, retries de optimistic locking e conflitos de lock, diferenciando HTTP, SQS e worker de referências sem IDs nas tags.
- T-011 instrumentou SQS, referências e Outbox para recebimento, replay, retry, DLQ, outcomes e snapshots; duração e lag passaram a usar `observe`/`set` sem valores dinâmicos em tags.
- T-012 adicionou observações de duração para wagering, consumo SQS e reprocessamento de referências; o publisher registra duração e lag em métricas apropriadas.
- T-013 criou o health check PostgreSQL read-only via `select 1`, com latência e normalização de falha sem detalhes internos.
- T-014 criou o health check SQS read-only com `GetQueueAttributes`, status separado para input/eventos e suporte a `disabled` quando o publisher Outbox está desligado.
- T-015 expôs o estado do publisher Outbox pela porta de health, distinguindo `disabled`, `up` e `degraded` e mantendo contagem/lag e código de falha sem payload.
- T-016 criou o agregador de readiness com checks paralelos, timeout individual/total configurável, política de dependências obrigatórias e métricas de health.
- T-017 adicionou `HealthModule`, `HealthController` e wiring de PostgreSQL/SQS/Outbox; `/health/live` permanece local e `/health/ready` mapeia não pronto para 503.
- T-018 adicionou `HEALTH_DEPENDENCY_TIMEOUT_MS` e `HEALTH_TOTAL_TIMEOUT_MS`, com defaults, limites e validação de deadline; os nomes foram documentados em `.env.example` sem incluir segredos.
- T-019 consolidou as verificações unitárias de sanitização, correlação, métricas por origem/duração, classificação permanente SQS e ausência de efeitos financeiros em envelopes inválidos.
- T-020 validou `/health/live` e `/health/ready` com PostgreSQL e LocalStack reais; o publisher desabilitado foi reportado sem bloquear readiness e a fila não foi consumida.
- T-021 executou a regressão completa com 142 testes aprovados, sem alteração do README e sem mudança observada nos efeitos financeiros, retries ou envelopes existentes.
- T-022 concluiu typecheck, build, suíte completa, integração real e auditoria de logs/endpoints; todas as tarefas T-001 a T-022 estão concluídas. O workspace não possui metadados `.git`, então a checagem Git foi registrada como indisponível; o README não foi editado.

Preencher as demais evidências durante a execução das tarefas. O status do plano deve permanecer aguardando aprovação final até que typecheck, build, suíte completa, testes de integração e critérios de aceite estejam evidenciados.

