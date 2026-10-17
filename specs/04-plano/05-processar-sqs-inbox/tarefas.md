# Tarefas — Processar transações por SQS com Inbox persistente

## Referências

- Spec: `specs/03-features/05-processar-sqs-inbox/spec.md`
- Plano: `specs/04-plano/05-processar-sqs-inbox/plano.md`
- Arquitetura: `specs/02-arquitetura/arquitetura.md`
- Produto: `specs/01-produto/spec.md`
- README: `README.md`

## Status

Rascunho — aguardando aprovação formal da Spec e do plano. Nenhuma tarefa foi iniciada.

Os templates `specs/04-plano/FEATURE_TEMPLATE/plano.md` e `tarefas.md` não estão presentes; esta lista segue o formato consolidado das features anteriores.

## Fase 1 — Base e persistência

- [ ] **T-001 [FR-001..FR-014] Mapear a integração com a arquitetura existente**
  - Revisar a Unit of Work, o `ProcessWagerTransactionUseCase`, repositórios financeiros, persistência de Outbox e configuração atual da aplicação.
  - Definir o ponto mínimo para transportar `consumerName`, `messageId` e `payloadHash` sem criar um segundo fluxo financeiro.
  - Confirmar as decisões aprovadas: `wager-transaction-consumer-v1`, Inbox por `(consumerName,messageId)`, estados da Inbox, redrive nativo com cinco recebimentos e backoff aprovado.
  - **Verificação:** registrar no plano técnico/PR a fronteira escolhida e demonstrar que o fluxo HTTP continuará chamando o mesmo caso de uso sem contexto SQS.

- [ ] **T-002 [FR-003, FR-004, FR-005, FR-006, FR-009, FR-010, FR-014] Criar o modelo de domínio da Inbox**
  - Criar a abstração em `src/modules/messaging/inbox/` para estados `PROCESSING`, `PROCESSED`, `FAILED_RETRYABLE` e `FAILED_PERMANENT`.
  - Modelar invariantes de `consumerName`, `messageId`, `payloadHash`, `attempts` e timestamps.
  - Definir portas de leitura, inserção, atualização de diagnóstico e consulta de replay/conflito.
  - **Verificação:** testes unitários comprovam transições válidas, rejeitam dados incompletos e não importam NestJS, MikroORM ou SDK SQS.

- [ ] **T-003 [FR-003, FR-004, FR-005, FR-006, FR-009, FR-010] Criar migration reversível da Inbox**
  - Criar tabela com `consumer_name`, `message_id`, `payload_hash`, `received_at`, `status`, `processed_at`, `attempts`, `last_error_code` e `last_error_at`.
  - Criar a restrição única `(consumer_name, message_id)`, validação de status e índice para consultas operacionais necessárias.
  - Manter retenção configurável em 30 dias sem implementar limpeza automática nesta feature.
  - **Verificação:** executar migration `up/down/up` em PostgreSQL e verificar unicidade, defaults, nulabilidade e reversibilidade.

- [ ] **T-004 [FR-003, FR-004, FR-005, FR-006, FR-009, FR-010, FR-014] Implementar entidade e repositório MikroORM**
  - Implementar o mapeamento da tabela e o adapter do repositório na infraestrutura.
  - Garantir que queries e atualizações preservem a restrição única e o diagnóstico mínimo.
  - Integrar o repositório à Unit of Work existente, sem tornar o domínio dependente do ORM.
  - **Verificação:** testes de integração criam, carregam, atualizam, detectam replay/conflito e persistem rollback sem deixar estado parcial.

- [ ] **T-005 [FR-001, FR-009, FR-010, FR-011, FR-012] Configurar portas, filas FIFO, DLQ e ambiente local**
  - Criar portas para receber, alterar visibilidade, confirmar/remover mensagem e iniciar/parar o consumer.
  - Adicionar ao ambiente local o serviço LocalStack/MiniStack e as filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`.
  - Configurar redrive nativo com `maxReceiveCount=5`, FIFO compatível e parâmetros de visibilidade/backoff.
  - **Verificação:** subir o ambiente local, verificar as duas filas e redrive, e provar que a aplicação não importa o SDK SQS fora do adapter.

- [ ] **T-006 [FR-001, FR-002, FR-014] Implementar validação do envelope e hash canônico**
  - Validar `messageId`, `type`, `occurredAt` e os dados obrigatórios de `WagerTransactionRequested`.
  - Mapear o payload de negócio para o comando já aceito pelo caso de uso.
  - Gerar hash determinístico apenas sobre o conteúdo de negócio, excluindo metadados de transporte que não mudam a transação.
  - **Verificação:** testes cobrem envelope válido, campo ausente, tipo inválido, datas inválidas, payload equivalente com mesma hash e payload alterado com hash diferente.

## Fase 2 — Lógica principal

- [ ] **T-007 [FR-002, FR-006, FR-007, FR-008] Integrar Inbox, caso de uso e Unit of Work**
  - Ajustar a fronteira existente para que, no fluxo SQS, a Inbox e o processamento financeiro sejam executados na mesma transação.
  - Persistir `PROCESSING` antes da execução e estado terminal antes do commit, sem alterar as regras do `ProcessWagerTransactionUseCase`.
  - Manter a atomicidade com wallet, transaction, ledger e Outbox.
  - **Verificação:** teste de integração confirma commit conjunto e rollback conjunto quando qualquer parte falha; o fluxo HTTP permanece sem registro de Inbox SQS.

- [ ] **T-008 [FR-003, FR-004, FR-005, FR-011] Implementar deduplicação, replay, conflito e corrida entre instâncias**
  - Tratar `(consumerName,messageId)` já existente com mesmo hash como replay seguro.
  - Tratar o mesmo identificador com hash diferente como conflito permanente e sem efeito financeiro.
  - Usar transação/lock e a restrição única do PostgreSQL para impedir processamento paralelo duplicado.
  - **Verificação:** testes concorrentes com duas execuções comprovam no máximo um efeito financeiro; replay não chama o caso de uso; conflito gera diagnóstico e não altera saldo/ledger.

- [ ] **T-009 [FR-002, FR-013] Implementar o consumer usando o mesmo caso de uso**
  - Receber a mensagem pela porta de transporte, validar o envelope e chamar o `ProcessWagerTransactionUseCase` existente.
  - Reutilizar o mesmo mapeamento e os mesmos erros de BET, WIN, LOSS, REFUND e ROLLBACK.
  - Não criar regras financeiras, entidades paralelas ou um segundo caso de uso para SQS.
  - **Verificação:** testes do consumer comprovam que cada tipo aceito chega ao mesmo caso de uso e que os testes HTTP existentes continuam passando.

- [ ] **T-010 [FR-007, FR-008] Implementar resultado terminal e ack pós-commit**
  - Persistir `PROCESSED` para sucesso e reconhecer resultados de negócio `REJECTED` e `PENDING_REFERENCE` como terminais para a entrega.
  - Executar `DeleteMessage` somente depois do commit da transação correspondente.
  - Em replay já concluído, confirmar sem nova chamada financeira.
  - **Verificação:** testes comprovam ack após commit, ack para rejeição de negócio/pending reference e ausência de ack quando o commit falha.

- [ ] **T-011 [FR-009] Implementar falhas transitórias e backoff**
  - Classificar falhas de infraestrutura/concorrência transitória sem gerar novo efeito financeiro.
  - Não remover a mensagem em falha transitória; ajustar visibilidade para `30s, 1m, 2m, 4m, 5m` quando aplicável.
  - Atualizar `FAILED_RETRYABLE`, `attempts`, `last_error_code` e `last_error_at` de forma segura, sem impedir a próxima tentativa.
  - **Verificação:** teste com relógio/adapter fake comprova os cinco intervalos, ausência de `DeleteMessage` e nova tentativa após a visibilidade.

- [ ] **T-012 [FR-001, FR-005, FR-010, FR-014] Implementar falhas permanentes, poison messages e DLQ**
  - Persistir `FAILED_PERMANENT` para envelope inválido, conflito de hash e falha permanente, sem efeito financeiro.
  - Aplicar a política de redrive nativo com `maxReceiveCount=5`; o consumer não deve apagar uma mensagem transitória para simular retry.
  - Garantir que a mensagem termine em `wager-transactions-dlq.fifo` com diagnóstico suficiente e sem payload financeiro completo em logs.
  - **Verificação:** teste de contrato local envia mensagem inválida/poison, confirma cinco recebimentos no máximo e verifica a presença na DLQ e o estado persistido.

- [ ] **T-013 [FR-004, FR-006, FR-007, FR-011] Garantir recuperação após crash e redelivery**
  - Simular falha depois do commit e antes da confirmação da mensagem.
  - Fazer a redelivery encontrar a Inbox concluída e não repetir wallet, ledger, transaction ou Outbox.
  - Simular rollback antes do commit e comprovar que a próxima entrega pode processar a mensagem.
  - **Verificação:** testes de integração com adapter controlável comprovam exatamente uma efetivação financeira para cada mensagem lógica.

- [ ] **T-014 [FR-012] Implementar desligamento gracioso do consumer**
  - Ao receber `SIGTERM`, impedir novas leituras, aguardar mensagens em voo dentro do limite operacional e devolver/permitir redelivery das que não puderem concluir.
  - Evitar aceitar novas mensagens durante o drain e encerrar polling, timers e conexões do adapter.
  - **Verificação:** teste de ciclo de vida comprova que nenhuma mensagem nova é iniciada após o sinal e que mensagens interrompidas não são perdidas.

- [ ] **T-015 [FR-014] Implementar logs estruturados e telemetria mínima**
  - Registrar `consumerName`, `messageId` ou identificador seguro, tipo, tentativa, estado e código de erro.
  - Não registrar payload financeiro completo, credenciais, receipt handle ou dados sensíveis desnecessários.
  - Expor contadores/diagnósticos mínimos para sucesso, replay, retry, permanente, DLQ e shutdown, conforme o padrão existente do projeto.
  - **Verificação:** testes/inspeção de logs comprovam campos estruturados e ausência do payload completo; build valida os tipos da telemetria.

## Fase 3 — Interface e wiring

- [ ] **T-016 [FR-001, FR-002, FR-007, FR-009, FR-010] Conectar o adapter SQS ao módulo de messaging**
  - Registrar portas, repository, consumer e configurações por injeção de dependência.
  - Manter o SDK SQS restrito à infraestrutura e preservar a separação de módulos prevista na arquitetura.
  - **Verificação:** teste de bootstrap inicia o consumer com dependências reais/fakes e falha claramente quando uma configuração obrigatória está ausente.

- [ ] **T-017 [FR-001, FR-009, FR-010, FR-012] Validar configuração e provisionamento local**
  - Validar `consumerName`, endpoint/region/credentials locais, nomes das filas, visibilidade, backoff e limite de redrive.
  - Garantir que o serviço local seja opcional para o fluxo HTTP e obrigatório apenas ao iniciar o consumer SQS.
  - **Verificação:** ambiente local sobe de forma reproduzível; configuração inválida falha cedo com mensagem segura e configuração válida aponta para as filas esperadas.

- [ ] **T-018 [FR-013] Preservar o contrato HTTP e a composição existente**
  - Evitar alterações nas rotas, DTOs e respostas HTTP atuais.
  - Confirmar que o registro do consumer não substitui nem duplica o wiring do caso de uso usado pelo HTTP.
  - **Verificação:** suíte de regressão HTTP e teste de bootstrap comprovam compatibilidade antes e depois da ativação do consumer.

## Fase 4 — Testes

- [ ] **T-019 [FR-001, FR-002, FR-014] Cobrir envelope, hash e classificação em testes unitários**
  - Testar envelope válido, inválido, tipo não suportado, hash estável e mapeamento para o comando existente.
  - Testar a classificação entre resultado de negócio, transitório e permanente.
  - **Verificação:** suíte unitária cobre os caminhos de aceitação e rejeição sem depender de PostgreSQL ou LocalStack.

- [ ] **T-020 [FR-003, FR-004, FR-005, FR-009, FR-010] Cobrir Inbox em PostgreSQL**
  - Testar migration, chave única, estados, timestamps, tentativas e diagnósticos.
  - Testar rollback e atualização concorrente do mesmo `(consumerName,messageId)`.
  - **Verificação:** testes de integração executam contra PostgreSQL real do ambiente do projeto e deixam o banco em estado limpo.

- [ ] **T-021 [FR-002, FR-006, FR-007, FR-008] Cobrir atomicidade financeira e Outbox**
  - Testar commit conjunto de Inbox, wallet, transaction, ledger e Outbox.
  - Testar rollback quando o caso de uso, o ledger ou a Outbox falhar.
  - **Verificação:** após cada cenário, consultar o banco e comprovar ausência de estado parcial ou efeito financeiro duplicado.

- [ ] **T-022 [FR-004, FR-005, FR-011] Cobrir replay, conflito, concorrência e crash**
  - Executar duas entregas idênticas, duas entregas concorrentes, duas entregas com hash diferente e redelivery após commit sem ack.
  - **Verificação:** exatamente um efeito financeiro para replay/concurrency; zero efeito para conflito; segunda entrega apenas confirma a Inbox concluída.

- [ ] **T-023 [FR-007, FR-008] Cobrir resultados de negócio**
  - Testar sucesso financeiro, rejeição de negócio e `PENDING_REFERENCE`.
  - **Verificação:** todos os resultados persistem seu estado, confirmam a mensagem somente após commit e não entram em retry financeiro.

- [ ] **T-024 [FR-009, FR-010] Cobrir retry, backoff, redrive e DLQ**
  - Executar falhas transitórias nos cinco intervalos e uma falha permanente/poison até o redrive.
  - **Verificação:** nenhum retry usa `DeleteMessage`, os tempos configurados são respeitados e a mensagem chega à DLQ após o limite do broker.

- [ ] **T-025 [FR-012] Cobrir `SIGTERM` e drain**
  - Simular sinal durante polling, durante transação e entre commit e ack.
  - **Verificação:** novas mensagens não são iniciadas, mensagens em voo concluem ou ficam disponíveis para redelivery, e o processo encerra sem tarefa órfã.

- [ ] **T-026 [FR-013] Executar regressão do fluxo HTTP**
  - Rodar a suíte existente para criação/consulta de wallet e processamento de BET, WIN, LOSS, REFUND e ROLLBACK via HTTP.
  - **Verificação:** contratos e efeitos existentes permanecem iguais, sem dependência do broker local.

## Fase 5 — Entrega

- [ ] **T-027 [FR-001..FR-014] Validar a entrega técnica completa**
  - Rodar typecheck, build, lint/testes disponíveis e a sequência de migration `up/down/up`.
  - Subir o ambiente local, executar os testes de integração SQS/PostgreSQL e revisar logs/diagnósticos.
  - Relacionar evidências aos AC-001..AC-011 e registrar limitações conhecidas, sem alterar o README.
  - **Verificação:** todos os comandos definidos pelo projeto passam; nenhum FR/AC fica sem evidência ou justificativa.

## Dependências e ordem

`T-001` deve preceder `T-002`–`T-007`. `T-003` precede `T-004` e os testes de banco. `T-005` e `T-006` precedem `T-009`. `T-007` e `T-008` precedem `T-010`–`T-014`. As tarefas de wiring (`T-016`–`T-018`) dependem das portas e da lógica principal. A fase de testes começa após as implementações correspondentes, e `T-027` é a validação final.

## Fora desta lista

- Publicador externo da Outbox.
- Mudança de regras financeiras ou criação de caso de uso paralelo.
- Alteração de contrato HTTP.
- Reconciliador, queries, autenticação, deploy e limpeza automática de retenção.
- Alteração do README.
