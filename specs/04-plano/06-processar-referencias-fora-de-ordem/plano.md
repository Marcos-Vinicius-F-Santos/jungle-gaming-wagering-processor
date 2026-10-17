# Plano de Implementação — Processar referências fora de ordem

Spec relacionada: [`../../03-features/06-processar-referencias-fora-de-ordem/spec.md`](../../03-features/06-processar-referencias-fora-de-ordem/spec.md)  
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature anterior: [`../05-processar-sqs-inbox/plano.md`](../05-processar-sqs-inbox/plano.md)  
Status: Implementação verificada — aguardando aprovação final

## 1. Resumo técnico

Completar e endurecer o fluxo de `PENDING_REFERENCE` já existente no módulo de wagering. A implementação deve manter a operação original persistida, consultar a referência com o mesmo contexto de negócio, reprocessar pelo `ProcessWagerTransactionUseCase` e concluir tudo na mesma Unit of Work financeira.

O foco desta rodada é a segurança do ciclo assíncrono entre a primeira entrega e a resolução da referência: agenda persistida, TTL sem reinício, seleção concorrente com `FOR UPDATE SKIP LOCKED`, reconsulta dentro da transação, transições atômicas, classificação de falhas e observabilidade mínima.

Não será criado um segundo fluxo financeiro, novo endpoint ou publicador externo da Outbox. A base atual de domínio, Outbox, SQS/Inbox e worker será reutilizada e ajustada somente onde necessário para cumprir a Spec aprovada.

## 2. Impacto no que já existe

| Componente/arquivo | Mudança planejada | Risco |
|---|---|---|
| `src/modules/wagering/application/pending-reference.worker.ts` | Manter polling configurável, lote padrão 50, drain seguro e encaminhamento de pendências ao caso de uso | Alto; worker concorrente ou não drenado pode duplicar efeitos ou perder tentativas |
| `src/modules/wagering/application/process-wager-transaction.use-case.ts` | Reconsultar/lockar a pendência dentro da Unit of Work e distinguir referência não terminal, incompatível e ausente | Muito alto; uma decisão stale pode gerar crédito, débito ou rejeição incorreta |
| `src/modules/wagering/application/reference-pending-policy.ts` | Preservar backoff e TTL aprovados, incluindo limite de agendamento | Alto; reinício de TTL pode manter pendências indefinidamente |
| `src/modules/wagering/application/wager-reference.validator.ts` | Aplicar a regra de referência não terminal versus terminal incompatível | Alto; rejeitar cedo demais pode perder uma operação válida |
| `src/modules/wagering/application/ports/wager-transaction-repository.port.ts` | Adicionar contrato de seleção/lock e reconsulta atômica de pendência | Muito alto; adapter incompleto deixa a garantia apenas em memória |
| `src/modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository.ts` | Implementar `FOR UPDATE SKIP LOCKED`, lock por id e filtros de estado/agenda | Muito alto; consulta incorreta pode processar a mesma pendência em duas instâncias |
| `src/modules/wagering/domain/wager-transaction.ts` | Preservar transições, limpeza de agenda e invariantes de estados | Alto; transição terminal incorreta quebra replay e auditoria |
| `src/modules/messaging/outbox/` | Garantir um evento por transição, sem duplicar pendência em cada retry | Alto; eventos duplicados ou fora da Unit of Work quebram consumidores |
| métricas e logs compartilhados | Instrumentar entrada, tentativa, sucesso, expiração, incompatibilidade, lock e idade | Médio; sem diagnóstico não há operação segura do worker |
| migrations existentes | Validar que os campos/índices de pendência suportam o plano; nenhuma alteração esperada inicialmente | Alto; schema divergente pode invalidar a agenda persistida |

## 3. Componentes e decisões técnicas

- **Seleção:** buscar registros `PENDING_REFERENCE` com `next_attempt_at <= now`, ordenados por agenda e id, em lote de 50, usando `FOR UPDATE SKIP LOCKED` quando a seleção fizer parte da Unit of Work.
- **Lock definitivo:** reconsultar e bloquear a transação por id dentro da Unit of Work antes de resolver a referência ou alterar qualquer entidade.
- **Estado atual:** se a operação não estiver mais pendente, estiver fora da agenda ou tiver sido concluída por outra instância, sair sem novo efeito.
- **Referência:** distinguir referência ausente, referência não terminal e referência terminal incompatível conforme a Spec aprovada.
- **Falha transitória:** manter a pendência elegível, sem criar rejeição ou evento financeiro duplicado; o retry de infraestrutura não reinicia `pendingSince`.
- **Falha de negócio:** rejeitar de forma terminal com código estável e evento Outbox atômico.
- **Efeito financeiro:** chamar as mesmas rotinas de WIN/REFUND/ROLLBACK existentes, incluindo wallet, optimistic locking, ledger e Outbox.
- **Outbox:** persistir somente eventos de transições reais; não publicar externamente nesta feature.
- **Persistência:** reutilizar `pending_since`, `next_attempt_at` e `pending_attempts`. Uma nova migration só será criada se a verificação encontrar uma lacuna indispensável; nesse caso, ela deverá ser reversível e aprovada antes da implementação.

## 4. Sequência de implementação

### Fase 1 — Base e contrato

1. Confirmar o estado real do domínio, repository, worker, Outbox e migration contra a Spec aprovada.
2. Definir o contrato de seleção/lock e a taxonomia de falha transitória do worker.
3. Validar constraints, índice de pendências e ciclo de migration sem alterar o README.

### Fase 2 — Reprocessamento seguro

1. Implementar seleção concorrente e lock persistente no repository MikroORM.
2. Fazer o caso de uso reconsultar a pendência dentro da Unit of Work.
3. Aplicar a distinção entre referência ausente, não terminal e incompatível.
4. Garantir transições atômicas para sucesso, rejeição e reagendamento.
5. Evitar eventos Outbox duplicados em retry, replay ou corrida entre instâncias.

### Fase 3 — Worker e operação

1. Ajustar polling, lote, backoff, expiração e shutdown usando a agenda persistida.
2. Manter falhas transitórias disponíveis para retry sem mascará-las como rejeição.
3. Adicionar logs e métricas para todo o ciclo da pendência.
4. Confirmar que SQS/Inbox continua fazendo ack apenas após o commit inicial.

### Fase 4 — Testes

1. Cobrir política, domínio e classificação em testes unitários.
2. Cobrir seleção com lock, concorrência, rollback e constraints em PostgreSQL real.
3. Cobrir resolução, expiração, referência incompatível, replay e reinício.
4. Executar regressão completa dos fluxos HTTP e SQS já implementados.

### Fase 5 — Entrega

1. Executar typecheck, build, testes e migration `up/down/up`.
2. Conferir evidências de cada FR e AC no checklist de convergência.
3. Revisar logs sem payload financeiro completo e métricas do worker.
4. Submeter a implementação para aprovação formal; não marcar a feature como concluída antes dessa revisão.

## 5. Riscos e mitigação

| Risco | Severidade | Mitigação |
|---|---:|---|
| Duas instâncias reprocessarem a mesma pendência | Crítica | `FOR UPDATE SKIP LOCKED`, lock por id dentro da Unit of Work, reconsulta de status e testes concorrentes |
| Worker usar registro stale | Crítica | Reidratação a partir da linha bloqueada dentro da transação, nunca confiar somente no candidato inicial |
| Referência não terminal ser rejeitada cedo demais | Alta | Regra explícita no validator, testes para estados pendentes e terminais |
| Falha transitória virar rejeição definitiva | Alta | Classificador separado, códigos estáveis, rollback e teste de retry |
| TTL ser reiniciado em retry/restart | Alta | Preservar `pendingSince`, limitar `nextAttemptAt` e testar reinício |
| Evento Outbox duplicado | Alta | Emitir somente em transições efetivas e validar unicidade/eventos por cenário |
| Worker bloquear wallets diferentes | Média | Lock somente na linha da pendência e optimistic locking por wallet, sem mutex global |
| Falha de Outbox deixar estado parcial | Crítica | Mesma Unit of Work e testes de rollback com PostgreSQL |
| Shutdown abandonar trabalho em voo | Alta | Parar polling, aguardar execução ativa e deixar pendências persistidas para redelivery do worker |

## 6. Critérios de aprovação do plano

- Cada tarefa referencia FRs/ACs e possui verificação objetiva.
- O plano reutiliza `ProcessWagerTransactionUseCase` e não cria fluxo financeiro paralelo.
- O agendamento permanece persistido e o TTL não reinicia.
- A seleção concorrente usa a proteção aprovada pelo PostgreSQL.
- Referência recuperada, wallet, ledger e Outbox permanecem atômicos.
- Falhas transitórias não produzem rejeição ou efeito financeiro parcial.
- A publicação externa da Outbox continua fora desta rodada.
- Não há alteração do README nem de contratos públicos não previstos.
