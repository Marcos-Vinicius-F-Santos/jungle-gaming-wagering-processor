# Tarefas — Teste de carga e capacidade operacional

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/12-teste-carga-capacidade/spec.md`](../../03-features/12-teste-carga-capacidade/spec.md)  
Arquitetura: [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)  
README: [`../../../README.md`](../../../README.md)  

Status: Implementação verificada — aguardando aprovação final  

## Regra das tarefas

Executar uma tarefa por vez, na ordem de dependência. Cada tarefa deve registrar arquivos alterados, comando de verificação e resultado. Não alterar regras financeiras, contrato HTTP, `ARCHITECTURE.md` ou `README.md` sem uma decisão explícita desta feature.

## Fase 1 — Baseline, contratos e configuração

- [x] **T-001 [FR-001..FR-011, AC-001..AC-010]** Confirmar baseline de carga e infraestrutura
  - Mapear Compose de resiliência, portas, filas, endpoints, métricas, tabelas e comandos existentes.
  - Confirmar quais dados e eventos já possuem timestamps suficientes para medir latência e Outbox lag.
  - **Verificação:** baseline confirmado em `docker-compose.resilience.yml`, `src/`, `test/resilience/` e `package.json`; `bun run typecheck` passou; `docker compose -f docker-compose.resilience.yml config` passou com PostgreSQL, LocalStack e três instâncias `resilience-app-1/2/3`.
  - **Evidência:** `docker-compose.resilience.yml`, `src/modules/messaging/`, `src/shared/infrastructure/metrics/`, `test/resilience/` e `package.json`.

- [x] **T-002 [FR-003, FR-004, FR-005, FR-010]** Definir contrato de configuração do teste
  - Implementar leitura/validação de cenário, aquecimento, duração, drenagem, concorrência, taxa, `runId` e diretório de relatório.
  - Rejeitar valores inválidos antes de subir a carga.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/load-config.test.ts` passou com 3 testes e 17 expectativas, cobrindo defaults, overrides, limites, cenário inválido, taxa inválida, `runId` inseguro e boolean inválido.
  - **Evidência:** `test/load/load-config.ts` e `test/unit/load-config.test.ts`.

- [x] **T-003 [FR-002, FR-003, FR-010]** Definir modelos de amostra e relatório
  - Criar contratos para amostras, contadores, percentis, ambiente, resultado de cenário, invariantes e limitações.
  - Separar IDs de correlação de tags agregadas e impedir payload financeiro completo no relatório padrão.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/load-report.test.ts` passou com 1 teste e 4 expectativas, validando serialização estruturada, percentis, invariantes, limitações e ausência de payload no relatório.
  - **Evidência:** `test/load/load-report.ts` e `test/unit/load-report.test.ts`.

- [x] **T-004 [FR-004, FR-005, FR-006, FR-007, FR-008]** Implementar coletor de métricas e percentis
  - Implementar relógio monotônico, contadores, duração, p50/p95/p99, throughput e outbox lag.
  - Registrar quantidade de amostras, unidade e ausência de dados sem inventar percentis.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/load-metrics.test.ts` passou com 3 testes e 11 expectativas, cobrindo contadores, gauges, p50/p95/p99, throughput, amostras vazias, unidades incompatíveis e valores inválidos.
  - **Evidência:** `test/load/load-metrics.ts` e `test/unit/load-metrics.test.ts`.

## Fase 2 — Dados isolados e invariantes

- [x] **T-005 [FR-002, FR-009, FR-011]** Criar fixture e gerador de dados por `runId`
  - Criar wallets, providers e referências necessárias sem colidir com execuções anteriores.
  - Guardar somente o catálogo mínimo de IDs necessário para validação e limpeza segura.
  - **Verificação:** `bun run typecheck` passou; `bun test test/load/load-fixtures.test.ts` passou com 2 testes e 7 expectativas, confirmando isolamento por `runId`, chaves estáveis no replay e rejeição de identificador inseguro.
  - **Evidência:** `test/load/load-fixtures.ts` e `test/load/load-fixtures.test.ts`; a validação contra PostgreSQL real será exercitada na matriz T-016.

- [x] **T-006 [FR-009, AC-005, AC-006, AC-007]** Implementar validador de invariantes e drenagem
  - Consultar saldo, ledger, transações, Inbox, Outbox e DLQ por cenário.
  - Validar saldo reconstruído, unicidade de efeitos, estados terminais, ausência de duplicidade e fila drenada.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/load-invariants.test.ts` passou com 3 testes e 10 expectativas, cobrindo equivalência decimal, violações de saldo/ledger, duplicidades, DLQ, fila não drenada e polling até drenagem.
  - **Evidência:** `test/load/load-invariants.ts` e `test/unit/load-invariants.test.ts`; a consulta contra PostgreSQL/SQS será conectada nos cenários T-009–T-012.

- [x] **T-007 [FR-010, FR-011, AC-009, AC-010]** Implementar writer de relatório e limpeza segura
  - Salvar relatório estruturado e resumo legível, incluindo configuração, ambiente, métricas, invariantes, falhas e limitações.
  - Preservar relatório parcial em interrupções e limpar apenas dados/serviços do `runId`.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/load-report-writer.test.ts` passou com 2 testes e 7 expectativas, validando arquivos JSON/Markdown, status interrompido, limitações vazias e proteção contra identificadores fora do `runId`.
  - **Evidência:** `test/load/load-report-writer.ts` e `test/unit/load-report-writer.test.ts`; a interrupção de processo será exercitada na T-015.

## Fase 3 — Gerador e cenários

- [x] **T-008 [FR-001, FR-003, FR-004, FR-005]** Implementar executor de ciclo de cenário
  - Orquestrar preparação, aquecimento de 30 segundos, medição de 2 minutos, encerramento dos geradores, drenagem e validação.
  - Expor seleção de cenário único e execução sequencial de `all`.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/load-executor.test.ts` passou com 2 testes e 4 expectativas, confirmando a ordem prepare → warmup → measurement → drain → validate e parada da geração em erro.
  - **Evidência:** `test/load/load-executor.ts` e `test/unit/load-executor.test.ts`; a execução real será conectada em T-014.

- [x] **T-009 [FR-001, FR-004, FR-005, FR-009, AC-001]** Implementar cenário `distributed-throughput`
  - Enviar operações válidas para wallets distintas nas três instâncias.
  - Medir throughput e latência HTTP/SQS/Outbox aplicáveis e validar invariantes por wallet.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/distributed-throughput.test.ts` passou com 1 teste e 4 expectativas; smoke test real com PostgreSQL, LocalStack e três consumers passou com 3 mensagens, 3 wallets, drenagem em 531ms, fila vazia e invariantes sem divergências, duplicidades ou saldo negativo.
  - **Evidência:** `test/load/scenarios/distributed-throughput.ts`, `test/unit/distributed-throughput.test.ts`, `src/infrastructure/database/mikro-orm.config.ts` e `docker-compose.resilience.yml`.

- [x] **T-010 [FR-001, FR-004, FR-005, FR-007, FR-009, AC-005]** Implementar cenário `hot-wallet`
  - Gerar operações concorrentes para uma wallet com saldo suficiente.
  - Medir lock conflicts, retries e latência sem alterar a política financeira.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/hot-wallet.test.ts` passou com 1 teste e 2 expectativas; smoke test real com 12 mensagens, grupos FIFO distintos, três consumers, drenagem em 532ms e uma wallet confirmou saldo/ledger consistentes, sem duplicidades, saldo negativo ou DLQ.
  - **Evidência:** `test/load/scenarios/hot-wallet.ts`, `test/unit/hot-wallet.test.ts` e `docker-compose.resilience.yml`.

- [x] **T-011 [FR-001, FR-004, FR-005, FR-006, FR-009, AC-006]** Implementar cenário `replay-redelivery`
  - Gerar replays idempotentes e redelivery controlado usando somente mecanismos de teste já existentes.
  - Medir replays, redeliveries, claims e custo de processamento adicional.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/replay-redelivery.test.ts` passou com 1 teste e 2 expectativas; smoke test real enviou 8 replays com o mesmo `messageId`/payload e deduplication IDs distintos, drenou em 15ms e confirmou invariantes sem duplicidade, divergência, saldo negativo ou DLQ.
  - **Evidência:** `test/load/scenarios/replay-redelivery.ts`, `test/unit/replay-redelivery.test.ts` e `docker-compose.resilience.yml`.

- [x] **T-012 [FR-001, FR-004, FR-005, FR-008, FR-009, AC-007]** Implementar cenário `outbox-pressure`
  - Gerar operações que produzam eventos e observar publisher, backlog e lag.
  - Registrar publicação, eventos pendentes e drenagem sem duplicidade incompatível.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/outbox-pressure.test.ts` passou com 1 teste e 3 expectativas; smoke test real com warmup/medição de 1s enviou 8 operações, mediu p50 de envio SQS de 4,88 ms, lag máximo do Outbox de 855 ms, drenou em 532 ms e confirmou invariantes finais sem duplicidade, divergência, saldo negativo ou DLQ.
  - **Evidência:** `test/load/scenarios/outbox-pressure.ts`, `test/unit/outbox-pressure.test.ts` e ambiente Docker de resiliência (`postgres`, `localstack`, `resilience-app-1..3`).

## Fase 4 — Orquestração e comando

- [x] **T-013 [FR-001, FR-003, FR-011, AC-001, AC-010]** Criar override Docker de carga
  - Reutilizar Compose de resiliência com três instâncias e adicionar somente configurações necessárias ao gerador/observação.
  - Configurar healthchecks, limites, filas e identificação de cenário sem substituir infraestrutura real.
  - **Verificação:** `docker compose -f docker-compose.resilience.yml -f docker-compose.load.yml config --quiet` passou; override aplicado com PostgreSQL, LocalStack e três instâncias; os três containers ficaram `healthy`; smoke test interno de `/health/live` retornou `{"status":"ok"}`.
  - **Evidência:** `docker-compose.load.yml` e `docker-compose.resilience.yml`.

- [x] **T-014 [FR-003, FR-004, FR-005, FR-006, FR-008, FR-010]** Registrar `bun run test:load`
  - Conectar o comando ao executor de cenários, configurações e writer de relatório.
  - Emitir resumo por cenário, duração, resultado, throughput, percentis, erros, conflitos e outbox lag.
  - **Verificação:** `bun run typecheck` passou; `bun run test:load` executou `outbox-pressure` em infraestrutura Docker real por 1s de aquecimento + 1s de medição, retornou `passed` e salvou relatório JSON/Markdown em `artifacts/load/smoke-t014.*`.
  - **Evidência:** `test/load/run-load.ts`, `test/load/load-report.ts`, `test/load/load-report-writer.ts` e script `test:load` em `package.json`.

- [x] **T-015 [FR-006, FR-007, FR-008, FR-011, AC-009]** Cobrir falhas, interrupção e limites
  - Testar dependência indisponível, instância unhealthy, fila não drenada, timeout, erro de geração e `SIGTERM`.
  - Garantir diagnóstico estruturado, relatório parcial e ausência de falso sucesso.
  - **Verificação:** `bun run typecheck` passou; testes de executor/orquestrador passaram com 4 testes e 11 expectativas, incluindo interrupção cooperativa, erro de geração e dependência indisponível; execução real com PostgreSQL em `127.0.0.1:19999` gerou `artifacts/load/smoke-t015-failure.*`, classificou `failed` e terminou com código 1.
  - **Evidência:** `test/load/load-executor.ts`, `test/load/run-load.ts`, `test/unit/load-executor.test.ts` e `test/unit/run-load.test.ts`.

## Fase 5 — Evidência, regressão e convergência

- [x] **T-016 [FR-001..FR-011, AC-001..AC-010]** Executar a matriz completa de carga
  - Rodar os quatro cenários com aquecimento e duração aprovados, registrar ambiente e resultados.
  - Repetir com `runId` diferente e comparar invariantes, sem exigir igualdade artificial de throughput.
  - **Verificação:** dois ciclos completos com 30s de aquecimento + 120s de medição por cenário passaram; `matrix-a` e `matrix-b` produziram relatórios comparáveis. Todos os 8 cenários terminaram com `status=passed`, invariantes aprovadas e fila drenada; operações enviadas variaram apenas pela temporização natural (distributed 360/360, hot-wallet 1073/1072, replay 720/719, outbox 720/719).
  - **Evidência:** `artifacts/load/matrix-a/matrix-a.json`, `artifacts/load/matrix-a/matrix-a.md`, `artifacts/load/matrix-b/matrix-b.json` e `artifacts/load/matrix-b/matrix-b.md`.

- [x] **T-017 [FR-001..FR-011]** Executar regressão financeira e de resiliência
  - Rodar typecheck, build, unitários, integração e `bun run test:resilience`.
  - Confirmar que nenhuma regra financeira, contrato HTTP ou README foi alterada.
  - **Verificação:** `bun run typecheck` e `bun run build` passaram; `bun run test:unit` passou com 170 testes/506 expectativas; `bun run test:integration` passou com 56 testes/218 expectativas após isolar os consumidores Docker; `bun run test:resilience` passou com 14 execuções (7 cenários em 2 ciclos), código 0.
  - **Evidência:** suites `test/unit`, `test/integration`, `test/resilience` e `test/resilience/run-resilience.ts`; a primeira execução de integração falhou por interferência dos publishers ativos, foi diagnosticada e repetida em isolamento com sucesso.

- [x] **T-018 [FR-001..FR-011, AC-001..AC-010]** Auditar convergência e preparar aprovação
  - Auditar Spec ↔ plano ↔ tarefas ↔ código ↔ relatórios ↔ arquitetura.
  - Registrar comandos, ambiente, resultados, limitações e arquivos gerados.
  - Atualizar Spec, plano e tarefas para `Implementação verificada — aguardando aprovação final`, sem aprovar automaticamente.
  - **Verificação:** T-001–T-017 estão concluídas; `bun run typecheck`, `bun run build`, 170 testes unitários, 56 testes de integração, 14 execuções de resiliência e 2 matrizes completas de carga passaram. `README.md` não foi alterado. Relatórios e limitações estão preservados em `artifacts/load/matrix-a`, `artifacts/load/matrix-b` e nos smoke tests; HTTP, CPU/memória e parte da classificação operacional permanecem explicitamente como limitações, sem inferência de capacidade de produção.
  - **Evidência:** Spec, plano, tarefas, `test/load`, `docker-compose.load.yml`, relatórios JSON/Markdown e suites de regressão.

## Dependências e ordem

`T-001` precede todas as demais. `T-002`–`T-004` precedem o gerador. `T-005` e `T-006` precedem os cenários. `T-007` precede interrupção e relatório final. `T-008` precede `T-009`–`T-012`. `T-013` e `T-014` integram a execução real. `T-015` precede a matriz completa. `T-016` e `T-017` precedem `T-018`.

## Fora da execução desta lista

- definir meta universal de RPS ou SLO de produção;
- otimizar automaticamente banco, pool, filas ou código financeiro;
- alterar regras de negócio, contratos públicos, retry, DLQ ou TTL;
- implementar autenticação;
- executar teste de produção, soak test ou chaos test não previsto na Spec;
- criar dashboard permanente;
- apagar volumes ou dados fora do `runId`.
