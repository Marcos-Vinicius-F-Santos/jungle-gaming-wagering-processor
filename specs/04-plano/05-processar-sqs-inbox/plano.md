# Plano de Implementação — Processar transações por SQS com Inbox persistente

## Referências

- Spec da feature: `specs/03-features/05-processar-sqs-inbox/spec.md`
- Arquitetura: `specs/02-arquitetura/arquitetura.md`
- Produto: `specs/01-produto/spec.md`
- README: `README.md`
- Plano anterior: `specs/04-plano/04-processar-refund-rollback/`
- Registro de decisão, se necessário: `specs/02-arquitetura/DECISAO_TEMPLATE.md`

## Status

Rascunho — aguardando aprovação formal da Spec e deste plano.

As sugestões das perguntas abertas foram aprovadas, mas a Spec ainda está marcada como `Rascunho — aguardando revisão e aprovação`. Este documento não autoriza a implementação por si só.

## Observação sobre o template

Os arquivos `specs/04-plano/FEATURE_TEMPLATE/plano.md` e `tarefas.md` não existem neste workspace. Este plano usa a estrutura consolidada dos planos anteriores, preservando as regras do prompt de geração.

## Objetivo

Adicionar o ingresso assíncrono de `WagerTransactionRequested` pela fila FIFO `wager-transactions.fifo`, com Inbox persistente, processamento idempotente e transacional, confirmação somente após o commit e tratamento explícito de retry, DLQ e desligamento gracioso.

O consumidor deve reutilizar o `ProcessWagerTransactionUseCase` existente. As regras financeiras não serão duplicadas no fluxo SQS, e o fluxo HTTP atual deverá permanecer compatível.

## Escopo incluído

- Validar o envelope recebido e produzir um hash estável do payload de negócio.
- Criar a Inbox persistente com chave única `(consumer_name, message_id)`.
- Usar o `consumerName` estável `wager-transaction-consumer-v1` em todas as instâncias.
- Integrar Inbox, processamento financeiro e persistência de Outbox na mesma transação SQL.
- Reutilizar o `ProcessWagerTransactionUseCase` para BET, WIN, LOSS, REFUND e ROLLBACK.
- Confirmar/remover a mensagem somente depois do commit.
- Tratar replay com mesmo hash sem novo efeito financeiro.
- Tratar conflito de mesmo `messageId` com hash diferente sem efeito financeiro e com diagnóstico.
- Classificar resultados de negócio, falhas transitórias e falhas permanentes.
- Configurar retry com visibilidade progressiva de `30s, 1m, 2m, 4m, 5m` e redrive nativo com `maxReceiveCount=5`.
- Configurar `wager-transactions-dlq.fifo` e o ambiente local com LocalStack/MiniStack conforme a arquitetura.
- Permitir redelivery seguro, concorrência entre instâncias e recuperação após falha antes do ack.
- Implementar parada graciosa em `SIGTERM`, sem aceitar novas mensagens e devolvendo mensagens em voo quando necessário.
- Registrar logs estruturados e diagnósticos sem payload financeiro completo.
- Cobrir o fluxo com testes unitários, integração PostgreSQL, contrato do broker e cenários end-to-end.

## Fora do escopo

- Publicador externo da Outbox ou integração com qualquer sistema consumidor.
- Novas regras financeiras ou um segundo caso de uso para SQS.
- Alteração do contrato HTTP existente.
- Reconciliação, consultas, autenticação ou limpeza automática de retenção além da configuração necessária.
- Teste de carga completo com três instâncias reais.
- Deploy, provisionamento de infraestrutura de produção e alteração do README.

## Decisões de desenho

### Inbox e unidade de trabalho

A Inbox será modelada dentro de `src/modules/messaging/inbox/`, respeitando a separação existente entre domínio, aplicação e infraestrutura. O domínio não conhecerá NestJS, MikroORM ou o SDK da AWS.

A operação de mensagem deverá registrar ou carregar a Inbox dentro da mesma unidade de trabalho que executa o caso de uso. O registro será colocado em `PROCESSING`, o caso de uso será executado e o resultado será persistido como `PROCESSED`, `FAILED_RETRYABLE` ou `FAILED_PERMANENT` antes do commit. Se a transação falhar, o efeito financeiro e as alterações transacionais da Inbox serão revertidos juntos.

O mínimo persistido será:

| Campo | Finalidade |
|---|---|
| `consumer_name` | Isolar versões/consumidores e compor a chave de idempotência |
| `message_id` | Identificar a mensagem lógica do envelope |
| `payload_hash` | Detectar replay idêntico e conflito de conteúdo |
| `received_at` | Auditoria da primeira entrega observada |
| `status` | Estado persistido do processamento |
| `processed_at` | Momento de conclusão terminal |
| `attempts` | Diagnóstico e limite operacional |
| `last_error_code` | Classificação curta e segura da última falha |
| `last_error_at` | Momento da última falha |

Não será armazenado o payload financeiro completo na Inbox ou nos logs.

### Idempotência e concorrência

A restrição única `(consumer_name, message_id)` será a proteção definitiva contra efeitos duplicados. Uma segunda entrega com o mesmo hash não executará o caso de uso novamente se a primeira já estiver concluída. Uma segunda entrega com hash diferente será conflito permanente, sem efeito financeiro.

Durante a corrida entre instâncias, a operação deverá depender da transação/lock do banco e da restrição única, não de um lock apenas em memória. Se a primeira transação fizer rollback, a entrega seguinte poderá processar a mensagem normalmente.

### Ack, retry e DLQ

O adaptador SQS ficará atrás de portas da aplicação. O consumer não usará o SDK diretamente no domínio ou no caso de uso.

- Resultado de negócio (`PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`): persistir o diagnóstico e confirmar a mensagem após o commit.
- Replay idêntico já processado: não executar o caso de uso e confirmar com segurança.
- Falha transitória: não confirmar; atualizar o diagnóstico quando possível e ajustar a visibilidade para `30s, 1m, 2m, 4m, 5m`.
- Falha permanente ou mensagem inválida: persistir `FAILED_PERMANENT` sem efeito financeiro e permitir o redrive nativo para a DLQ conforme a política aprovada.
- A política nativa do broker será `maxReceiveCount=5`; o consumer não fará `DeleteMessage` em falhas transitórias.

O valor exato do tempo de visibilidade também deverá respeitar uma margem sobre o tempo máximo esperado do processamento, para evitar redelivery enquanto a primeira transação ainda está em andamento.

### Contexto do caso de uso

O consumidor usará o `ProcessWagerTransactionUseCase` existente. Caso seja necessário ajustar a fronteira da unidade de trabalho, a mudança deverá adicionar apenas contexto de mensagem/Inbox ao fluxo existente, mantendo as mesmas regras e o mesmo caminho financeiro. O fluxo HTTP continuará sem Inbox de SQS e sem alteração de contrato.

### Ambiente local

O `docker-compose.yml` deverá ganhar apenas o suporte necessário ao broker local e às filas FIFO, incluindo a fila principal, DLQ, redrive e variáveis/configuração do consumer. A infraestrutura será acessada por portas e adapters, de modo que o teste de aplicação não dependa diretamente de LocalStack.

## Fases de implementação

### Fase 1 — Base e persistência

1. Confirmar a fronteira da unidade de trabalho atual, o contrato do caso de uso e a persistência de Outbox existente.
2. Criar o modelo de domínio/porta da Inbox e seus estados.
3. Criar a migration reversível, índices e restrições.
4. Implementar entidade e repositório MikroORM sem expor ORM à aplicação.
5. Criar portas/configuração do transporte e o ambiente local com filas FIFO/DLQ.
6. Implementar validação do envelope e hash canônico do payload de negócio.

### Fase 2 — Lógica principal

1. Integrar Inbox e processamento financeiro na unidade de trabalho existente.
2. Implementar deduplicação, replay, conflito de hash e concorrência.
3. Implementar o consumer usando o mesmo caso de uso.
4. Implementar classificação de resultado, ack pós-commit, retry e redrive.
5. Implementar diagnósticos, logs/telemetria e desligamento gracioso.

### Fase 3 — Interface e wiring

1. Conectar o adapter SQS ao módulo de messaging por injeção de dependência.
2. Validar configuração obrigatória, nomes de filas, endpoints locais e parâmetros de visibilidade.
3. Manter o módulo HTTP e seu contrato inalterados.

### Fase 4 — Testes

1. Testar domínio, envelope, hash e classificação sem broker.
2. Testar migration, repositório e atomicidade com PostgreSQL.
3. Testar contrato do SQS/LocalStack, redrive e DLQ.
4. Testar replay, conflito, concorrência, falha antes do ack, resultados de negócio, retry, DLQ e `SIGTERM`.
5. Executar a regressão do fluxo HTTP.

### Fase 5 — Entrega

1. Rodar build, typecheck e suíte completa.
2. Validar migration `up/down/up` e o ambiente local.
3. Revisar logs sem dados sensíveis, checklist de requisitos e evidências dos ACs.
4. Solicitar aprovação final antes de considerar a feature pronta.

## Impacto técnico

| Área | Impacto | Estratégia |
|---|---|---|
| Domínio/aplicação | Novo contexto de mensagem e estados da Inbox | Portas e value objects sem dependência de framework |
| Persistência | Nova tabela e repositório | Migration reversível, índice único e estados restritos |
| Transação | Inbox precisa acompanhar wallet/ledger/Outbox | Reutilizar a Unit of Work existente |
| Messaging | Novo consumer e adapter SQS | SDK isolado em infraestrutura |
| Configuração | Filas, DLQ, redrive, visibilidade e consumer name | Configuração validada e ambiente local reproduzível |
| HTTP | Nenhuma mudança contratual | Teste de regressão obrigatório |
| Operação | Retry, DLQ, logs e shutdown | Estados/diagnósticos mínimos e sem payload completo |

## Riscos e Registros de Decisão

| Risco | Severidade | Mitigação | Registro de Decisão? |
|---|---:|---|---|
| Ack antes do commit produzir perda de mensagem ou commit duplicado produzir efeito financeiro | Crítica | Ack somente após commit, Inbox única e testes de crash/redelivery | Não neste momento; já definido na arquitetura/Spec. Se a Unit of Work precisar ser redesenhada, abrir registro antes da implementação. |
| Duas instâncias processarem o mesmo `messageId` simultaneamente | Alta | Restrição única, lock/transação PostgreSQL e teste concorrente | Não; consequência direta da decisão aprovada de Inbox. |
| Classificar uma falha financeira como transitória ou de negócio | Alta | Taxonomia explícita, códigos estáveis e testes por tipo de erro | Sim, se a implementação precisar introduzir uma classificação nova não prevista na Spec. |
| Diferenças entre SQS real e LocalStack/MiniStack, principalmente redrive FIFO | Média/alta | Portas de transporte, teste de contrato e configuração documentada | Sim, se houver comportamento incompatível que exija alterar o contrato do adapter. |
| Visibilidade menor que o tempo da transação causar redelivery prematuro | Alta | Configuração com margem, extensão de visibilidade e teste de processamento lento | Não, salvo mudança do backoff aprovado. |
| Mensagem presa em `PROCESSING` após falha inesperada | Alta | Estados atualizados na mesma transação, tratamento de stale processing e teste de rollback | Sim, se for necessário um job de recuperação separado. |
| Logs ou diagnósticos exporem dados financeiros | Média | `last_error_code` curto, sem payload completo, revisão de logs | Não. |
| Alteração do caso de uso quebrar o HTTP | Alta | Contexto opcional de mensagem e regressão HTTP | Não, a menos que o contrato público precise mudar. |

## Critérios de aprovação do plano

- Cada tarefa referencia um ou mais FRs e possui verificação objetiva.
- O plano não cria um fluxo financeiro paralelo ao `ProcessWagerTransactionUseCase`.
- A Inbox, wallet, transaction, ledger e Outbox permanecem atômicos.
- O broker confirma apenas após commit e usa redrive nativo com `maxReceiveCount=5`.
- Os cenários de replay, conflito, concorrência, retry, DLQ, shutdown e HTTP estão cobertos nas tarefas.
- Nenhuma tarefa altera o README ou inclui o publicador externo da Outbox.
