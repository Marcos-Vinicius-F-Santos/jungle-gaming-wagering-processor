# Plano de Implementação — Resiliência operacional do processamento SQS/Inbox

Spec relacionada: [`../../03-features/11-resiliencia-sqs-inbox/spec.md`](../../03-features/11-resiliencia-sqs-inbox/spec.md)  
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto relacionado: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Feature base: [`../05-processar-sqs-inbox/plano.md`](../05-processar-sqs-inbox/plano.md)  

Status: Implementação verificada — aguardando aprovação final  

## 1. Objetivo do plano

Implementar e verificar as garantias operacionais que ainda não estão comprovadas no processamento SQS: múltiplas instâncias reais, entregas duplicadas concorrentes, crash antes e depois do commit, recuperação de Inbox em processamento, reinício e `SIGTERM`.

O plano preserva o desenho existente: o consumer chama `ProcessWagerTransactionUseCase`, o PostgreSQL coordena a consistência financeira e o SQS fornece entrega, visibilidade e redelivery. Não será criado fluxo financeiro alternativo para cenários de falha.

## 2. Decisões aplicadas

- Orquestração com Docker Compose, PostgreSQL e LocalStack compartilhados por três instâncias independentes da aplicação/consumer.
- Injeção de crash somente em ambiente de teste, por configuração ou adapter instrumentável; nenhuma rota administrativa será adicionada.
- Janela entre commit e `DeleteMessage` será observável no harness para comprovar redelivery pós-commit.
- Inbox terá claim/lease persistente suficiente para recuperar processamento abandonado sem lock global em memória.
- O comando dedicado será `bun run test:resilience`.
- O backoff, TTL de referências, regras financeiras, contrato HTTP e políticas de DLQ já aprovados permanecem inalterados.
- O teste de carga (`bun run test:load`) será tratado em uma entrega operacional posterior.

## 3. Baseline e impacto

### Já existente

- `SqsWagerTransactionConsumer` e adapter SQS.
- Inbox persistente com chave `(consumerName, messageId)`.
- Unit of Work compartilhada com processamento financeiro.
- Idempotência persistente, optimistic locking, ledger e Outbox.
- Logs, métricas, health checks e testes básicos de SQS/Inbox.
- Docker Compose para PostgreSQL e LocalStack.

### A complementar

- claim/lease e recuperação de Inbox abandonado;
- ciclo de vida controlado do consumer durante `SIGTERM`;
- pontos de injeção de falha exclusivos para testes;
- infraestrutura para três instâncias independentes;
- cenários reais de redelivery, restart, crash e concorrência;
- comando e relatório de resiliência.

### A preservar

- efeitos financeiros e eventos existentes;
- ack somente depois do commit;
- classificação de negócio, transitório e permanente;
- execução paralela de wallets distintas;
- ausência de payload financeiro completo em logs.

## 4. Desenho técnico

### 4.1 Claim e lease do Inbox

O repository do Inbox deverá oferecer uma operação persistente para adquirir ou renovar o processamento de uma mensagem, condicionada a:

- inexistência do registro;
- estado não terminal com lease expirada;
- mesma mensagem e mesmo hash;
- não haver outro claim ativo.

A operação deve retornar uma decisão explícita (`CLAIMED`, `PROCESSED`, `IN_FLIGHT`, `PAYLOAD_CONFLICT` ou equivalente), sem expor tipos do MikroORM ao consumer.

Se o schema atual não comportar a recuperação de processamento abandonado, criar migration reversível com os campos mínimos de lease, por exemplo `claimed_by`, `lease_until` e `processing_started_at`. A migration deve ser validada com `up/down/up` e não pode remover histórico.

### 4.2 Unit of Work financeira

Depois de obter o claim, o consumer executará o caso de uso financeiro na Unit of Work existente. O commit deverá incluir, quando aplicável:

- resultado da `WagerTransaction`;
- alteração da wallet;
- ledger;
- Outbox;
- transição do Inbox para `PROCESSED` ou falha persistida.

O claim não pode autorizar efeitos financeiros fora da Unit of Work nem permitir que um segundo processo ultrapasse uma lease ativa.

### 4.3 Fault injection

Criar uma porta ou estratégia de teste que permita sinalizar pontos controlados:

1. antes do commit financeiro;
2. depois do commit e antes do ack;
3. durante mensagem em voo no shutdown;
4. opcionalmente depois do publish da Outbox e antes da confirmação do publisher.

Em produção, a estratégia deve permanecer desabilitada e não deve alterar o fluxo normal.

### 4.4 Orquestração

Criar uma composição específica de resiliência, sem substituir o `docker-compose.yml` principal, com:

- PostgreSQL;
- LocalStack/MiniStack;
- três serviços de aplicação usando a mesma configuração de fila e banco;
- healthchecks e dependências explícitas;
- isolamento de dados por execução;
- mecanismo para parar/reiniciar um único consumer durante o cenário.

Se a imagem da aplicação ainda não existir, adicionar apenas o artefato mínimo necessário para a composição de teste, sem alterar o runtime financeiro.

### 4.5 Cenários

O harness deve cobrir, no mínimo:

| Cenário | Resultado esperado |
|---|---|
| Duplicidade em três instâncias | um efeito financeiro |
| Crash antes do commit | redelivery processa integralmente |
| Crash depois do commit, antes do ack | replay sem segundo efeito |
| Inbox com lease expirada | outra instância assume |
| Restart durante entrega | mensagens confirmadas não reaplicam |
| `SIGTERM` com mensagem em voo | conclui ou devolve com segurança |
| Falha transitória | retry/backoff sem efeito parcial |
| Falha permanente | DLQ sem efeito financeiro |
| Wallets distintas | paralelismo preservado |

## 5. Observabilidade e diagnóstico

Adicionar ou validar métricas e logs para:

- claim obtido, negado e expirado;
- mensagem em voo e redelivery;
- replay de Inbox;
- crash/restart injetado;
- commit concluído antes do ack;
- rollback antes do commit;
- shutdown concluído e mensagens devolvidas;
- retry, conflito e DLQ;
- duração total e diferença entre saldo materializado e ledger.

Tags devem usar somente dimensões controladas, como `queue`, `outcome`, `classification`, `source` e `reason`. IDs devem ficar apenas em campos estruturados de log sanitizado.

## 6. Estratégia de testes

### Unitários

- decisões de claim/lease;
- lease ativa versus expirada;
- conflito de payload;
- transições de shutdown;
- classificação de pontos de falha;
- isolamento da fault injection;
- métricas e logs sem payload sensível.

### Integração PostgreSQL

- migration e constraints do Inbox;
- dois claims concorrentes para a mesma mensagem;
- recuperação de lease expirada;
- rollback antes do commit;
- atomicidade de Inbox, wallet, ledger e Outbox;
- invariável saldo versus ledger.

### Integração LocalStack/MiniStack

- redelivery após ausência de ack;
- crash após commit e antes do ack;
- visibilidade e retry;
- DLQ para falha permanente;
- shutdown com mensagens em voo.

### Processo e restart

- três instâncias independentes;
- parada e reinício de uma instância;
- ausência de lock global;
- execução repetida com dados isolados;
- relatório final por cenário.

## 7. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Segundo processo assumir lease ainda ativa | update condicional, timestamp do banco e teste concorrente real |
| Crash pós-commit duplicar efeito | Inbox terminal + idempotência financeira + teste entre commit e ack |
| Mensagem ficar presa em `PROCESSING` | lease expirada, recuperação explícita e teste de restart |
| Harness mascarar falha com mocks | PostgreSQL/LocalStack reais e processos independentes |
| Shutdown confirmar mensagem incompleta | estado de drain, rastreamento de in-flight e teste de `SIGTERM` |
| Três instâncias não compartilharem estado | configuração comum e asserts no banco compartilhado |
| Dados residuais contaminarem o cenário | IDs por execução, filas isoladas e limpeza limitada ao escopo |
| Fault injection vazar para produção | configuração fail-closed e provider exclusivo de teste |
| Alterar regra financeira sem perceber | regressão HTTP, unitária e invariável final em todos os cenários |

## 8. Critérios para considerar o plano concluído

- Todos os requisitos FR-001 a FR-011 têm tarefa e evidência objetiva.
- Cada cenário AC-001 a AC-010 roda com infraestrutura real ou comprova explicitamente por que o ambiente equivalente é necessário.
- Nenhum cenário depende de mock como única prova de consistência.
- Typecheck, build e regressão financeira passam.
- O comando `bun run test:resilience` é repetível e informa falhas por cenário.
- A documentação registra limitações, tempos de visibilidade, injeção de crash e modo de execução.
- A Spec, o plano e as tarefas permanecem aguardando aprovação final; nenhuma aprovação é marcada automaticamente.
