# Spec da Feature — Processar transações por SQS com Inbox persistente

Status: Rascunho — aguardando revisão e aprovação
Projeto: Distributed Wagering Processor
Onde vive no código: `src/modules/messaging/inbox/`, adapter SQS, `src/modules/wagering/` e Unit of Work
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Feature anterior: [`../04-processar-refund-rollback/spec.md`](../04-processar-refund-rollback/spec.md)

> O template `specs/03-features/FEATURE_TEMPLATE/spec.md` previsto pelo prompt não existe neste repositório. Esta Spec segue a estrutura consolidada das features anteriores.

## 1. Objetivo

Adicionar a entrada assíncrona de transações de wagering por AWS SQS, usando as filas locais `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, um Inbox persistente para deduplicação e o mesmo caso de uso financeiro já utilizado pelo HTTP.

O consumidor deve preservar as garantias existentes de idempotência, optimistic locking, saldo, ledger, Outbox e referências pendentes quando uma mensagem for duplicada, reentregue, processada depois de uma falha ou recebida em uma instância diferente.

O `ack`/delete da mensagem somente poderá ocorrer depois do commit da transação SQL que registrar o Inbox e os efeitos financeiros. O publisher externo da Outbox permanece fora desta feature.

## 2. Como funciona hoje

O sistema recebe `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` somente pelo endpoint HTTP `POST /wagering/transactions`. O controller valida o DTO e `Idempotency-Key`, chama `ProcessWagerTransactionUseCase`, e o caso de uso persiste transação, wallet, ledger quando aplicável e Outbox na mesma Unit of Work.

O banco já protege unicidade de transações e idempotência, o processamento financeiro usa optimistic locking com até três tentativas, e referências ausentes podem ficar como `PENDING_REFERENCE` para reprocessamento pelo worker interno.

O projeto ainda não possui Inbox persistente, adapter SQS, consumer, configuração de filas, redelivery controlado ou DLQ. Esta feature adicionará somente o novo canal de entrada e seus mecanismos de entrega; o comportamento do HTTP deve permanecer inalterado.

## 3. Requisitos funcionais

### FR-001 — Receber mensagem de transação

QUANDO o consumer receber uma mensagem da fila `wager-transactions.fifo`

O SISTEMA DEVE ler e validar o envelope `WagerTransactionRequested`, incluindo `messageId`, `type`, `occurredAt` e os campos de negócio necessários para construir o mesmo comando aceito pelo caso de uso HTTP.

### FR-002 — Reutilizar o caso de uso financeiro

QUANDO o envelope for válido

O SISTEMA DEVE converter `data` para `ProcessWagerTransactionCommand` e chamar `ProcessWagerTransactionUseCase`, sem criar uma regra financeira paralela no consumer.

O consumer não pode alterar saldo, criar ledger ou decidir a direção financeira diretamente.

### FR-003 — Persistir Inbox por consumidor e mensagem

QUANDO uma mensagem válida for recebida

O SISTEMA DEVE registrar ou localizar um Inbox por `(consumerName, messageId)`, armazenando pelo menos `payloadHash`, `receivedAt` e o estado de processamento.

A unicidade deve ser persistente e funcionar com múltiplas instâncias concorrentes.

### FR-004 — Deduplicar mensagem já processada

QUANDO uma mensagem com o mesmo `(consumerName, messageId)` e o mesmo `payloadHash` for reentregue depois de já ter sido processada

O SISTEMA DEVE reconhecer o replay, não chamar novamente o efeito financeiro, não criar novo ledger ou Outbox e confirmar a mensagem de forma segura.

### FR-005 — Rejeitar conflito de payload do Inbox

QUANDO o mesmo `(consumerName, messageId)` for recebido com `payloadHash` diferente

O SISTEMA DEVE tratar a mensagem como conflito permanente, preservar o processamento original e impedir qualquer efeito financeiro adicional.

O conflito deve ser auditável em log estruturado e encaminhado para a política de falha permanente definida para a fila.

### FR-006 — Atomicidade entre Inbox e processamento

QUANDO uma mensagem válida for processada

O SISTEMA DEVE confirmar, na mesma transação SQL, o Inbox processado, a `WagerTransaction`, a alteração da wallet, o ledger quando aplicável e os eventos da Outbox.

Se qualquer parte falhar antes do commit, todos os registros devem ser revertidos e a mensagem não pode ser confirmada como processada.

### FR-007 — Confirmar somente após commit

QUANDO o caso de uso concluir com `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` persistido

O SISTEMA DEVE executar o `ack`/delete da mensagem somente depois que o commit SQL tiver sido confirmado.

Se o processo cair entre o commit e o `ack`, a reentrega deve ser segura por causa do Inbox e da idempotência financeira.

### FR-008 — Confirmar rejeições de negócio persistidas

QUANDO o caso de uso retornar uma rejeição de negócio persistida, como saldo insuficiente, referência incompatível ou `REVERSAL_NEGATIVE_BALANCE`

O SISTEMA DEVE considerar a mensagem concluída, manter a transação rejeitada e confirmar a mensagem, sem retry financeiro.

Uma operação `PENDING_REFERENCE` também deve ser confirmada depois que sua pendência e Outbox forem persistidas, pois o worker interno continuará o processamento.

### FR-009 — Reprocessar falhas transitórias

QUANDO ocorrer uma falha transitória de banco, SQS, optimistic locking esgotado ou infraestrutura durante o processamento

O SISTEMA DEVE deixar a mensagem disponível para nova tentativa, sem marcar o Inbox como processado e sem produzir efeito financeiro parcial.

As tentativas devem usar backoff de `30s`, `1m`, `2m`, `4m` e `5m`, respeitando o limite aprovado para SQS.

### FR-010 — Encaminhar falhas permanentes para DLQ

QUANDO uma mensagem exceder cinco tentativas ou for classificada como falha permanente, como envelope inválido ou conflito irreconciliável de payload

O SISTEMA DEVE encaminhá-la para `wager-transactions-dlq.fifo`, registrar diagnóstico suficiente para investigação e não aplicar qualquer efeito financeiro indevido.

### FR-011 — Suportar redelivery

QUANDO a mesma mensagem for entregue novamente por timeout de visibilidade, crash, reinício ou múltiplas instâncias

O SISTEMA DEVE preservar a unicidade do efeito financeiro, do ledger por transação e dos eventos da Outbox, independentemente da quantidade de entregas.

### FR-012 — Encerrar com segurança

QUANDO o processo receber `SIGTERM`

O SISTEMA DEVE parar de aceitar novas mensagens, permitir que mensagens em processamento terminem e confirmem após commit, ou devolver a visibilidade das mensagens que não puder concluir.

O encerramento não pode confirmar uma mensagem cujo Inbox ou processamento financeiro não tenha sido commitado.

### FR-013 — Manter compatibilidade com HTTP

QUANDO a mesma operação for submetida por HTTP ou SQS

O SISTEMA DEVE usar os mesmos contratos de domínio, idempotência, referências, optimistic locking, saldo, ledger e Outbox. A introdução do consumer não pode alterar status ou efeitos do endpoint HTTP.

### FR-014 — Registrar observabilidade da entrega

QUANDO uma mensagem for recebida, deduplicada, processada, rejeitada, reenfileirada, enviada à DLQ ou devolvida durante shutdown

O SISTEMA DEVE produzir logs estruturados com, quando disponíveis, `consumerName`, `messageId`, `correlationId`, `transactionId`, `walletId`, `providerId`, tentativa e classificação da falha, sem registrar o payload financeiro completo ou dados sensíveis.

## 4. Envelope e contrato da mensagem

### Envelope mínimo

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

### Regras do envelope

- `type` deve ser exatamente `WagerTransactionRequested` nesta primeira versão.
- `messageId` deve ser não vazio e estável entre redeliveries.
- `occurredAt` deve ser uma data ISO-8601 válida; ela não reinicia TTL de referências nem substitui o relógio do processamento.
- `data` deve conter o mesmo conjunto de campos de negócio aceito pelo caso de uso HTTP, incluindo `idempotencyKey`.
- O `payloadHash` do Inbox deve ser calculado sobre o payload de negócio canônico, sem receipt handle, headers ou metadados de transporte.
- Valores continuam strings decimais exatas e moedas ISO-4217 normalizadas.

## 5. Regras de negócio e entrega

### BR-001 — Filas

O consumer deve consumir `wager-transactions.fifo` e usar `wager-transactions-dlq.fifo` para falhas permanentes ou mensagens que excederem cinco tentativas.

### BR-002 — Inbox como fonte persistente de deduplicação

A deduplicação deve usar PostgreSQL e a chave `(consumerName, messageId)`. Cache em memória, ordenação FIFO ou `MessageDeduplicationId` do SQS não substituem o Inbox.

### BR-003 — Hash e conflito

O mesmo `messageId` com payload igual é replay seguro. O mesmo `messageId` com payload diferente é conflito permanente e nunca deve executar o caso de uso novamente.

### BR-004 — Estados do Inbox

O Inbox deve distinguir, no mínimo, mensagem recebida/em processamento, processada e falha que ainda pode ser tentada novamente. O estado `processedAt` só pode ser preenchido dentro da transação que confirma o resultado do caso de uso.

### BR-005 — Classificação de falhas

- Resultado financeiro `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` persistido: sucesso, confirmar mensagem.
- Falha transitória de infraestrutura ou optimistic locking: não confirmar, aplicar retry/backoff.
- Envelope inválido, tipo não suportado ou conflito de payload: falha permanente, sem efeito financeiro e com destino na DLQ.
- Falha de publicação externa da Outbox não pertence ao ack do request SQS nesta feature; a Outbox permanece persistida para o publisher da feature correspondente.

### BR-006 — Atomicidade

Inbox, `WagerTransaction`, wallet, ledger e Outbox devem participar da mesma Unit of Work quando a mensagem chegar a um resultado persistido.

### BR-007 — Shutdown

O consumer deve controlar mensagens em voo e, durante `SIGTERM`, não iniciar novos processamentos. Mensagens não concluídas devem permanecer disponíveis para redelivery ou ter sua visibilidade devolvida explicitamente.

### BR-008 — Concorrência

Múltiplas instâncias podem receber a mesma mensagem. A constraint do Inbox, a idempotência da transação, a unicidade do ledger e o optimistic locking devem decidir de forma persistente, sem lock global em memória.

## 6. Persistência do Inbox

A tabela `inbox_messages` deve conter, no mínimo:

- `consumer_name`;
- `message_id`;
- `payload_hash`;
- `received_at`;
- estado de processamento;
- `processed_at`, quando concluída;
- diagnóstico/tentativa suficiente para retry e investigação, conforme a decisão de schema;
- `UNIQUE(consumer_name, message_id)`.

A migration deve ser versionada e reversível. O processamento do Inbox não pode apagar a mensagem financeira nem sobrescrever o histórico de uma entrega já concluída.

## 7. Integração com SQS

O adapter SQS deve ficar atrás de portas de mensageria e não pode vazar SDK para o domínio ou para o caso de uso.

O consumer deve:

1. receber a mensagem e capturar `receiptHandle` apenas na infraestrutura;
2. validar o envelope;
3. registrar/localizar o Inbox dentro da Unit of Work;
4. deduplicar ou chamar `ProcessWagerTransactionUseCase`;
5. classificar o resultado ou erro;
6. commitar Inbox e efeitos financeiros quando aplicável;
7. somente depois executar delete/ack;
8. em falha transitória, alterar visibilidade ou deixar a mensagem para o retry configurado;
9. em falha permanente, encaminhar à DLQ sem criar efeito financeiro;
10. respeitar o ciclo de shutdown.

O consumer não deve chamar diretamente repositórios de wallet, ledger ou wagering fora do caso de uso. O adapter deve poder ser substituído por LocalStack/MiniStack em testes sem alterar o domínio.

## 8. Critério de aceite

### AC-001 — Processamento assíncrono de BET

Dado um envelope válido `WagerTransactionRequested` contendo uma `BET`, quando o consumer o receber, então deve chamar o mesmo caso de uso do HTTP, persistir o Inbox e o débito com ledger/Outbox na mesma transação, e confirmar a mensagem somente depois do commit.

### AC-002 — Replay da mesma mensagem

Dado que uma mensagem já foi processada e seu Inbox está marcado como concluído, quando o mesmo `messageId` e payload forem reentregues, então o consumer deve confirmar a mensagem sem novo débito, ledger, alteração de versão ou Outbox.

### AC-003 — Crash antes do ack

Dado que o PostgreSQL confirmou o Inbox e o efeito financeiro, quando o processo cair antes do delete/ack, então a redelivery deve encontrar o Inbox processado e não duplicar o efeito.

### AC-004 — Mensagens concorrentes

Dado que duas instâncias recebam a mesma mensagem simultaneamente, quando ambas tentarem processá-la, então somente uma deve produzir o efeito financeiro e a outra deve reconhecer a duplicidade sem novo ledger.

### AC-005 — Rejeição de negócio

Dado um envelope válido cuja operação seja rejeitada pelo caso de uso por regra de negócio, quando o processamento terminar, então a rejeição deve estar persistida com auditoria/Outbox e a mensagem deve ser confirmada sem retry financeiro.

### AC-006 — Referência pendente

Dado um `REFUND` ou `ROLLBACK` válido cuja referência ainda não exista, quando a mensagem for consumida, então o Inbox, a transação `PENDING_REFERENCE` e o evento correspondente devem ser persistidos atomicamente, a mensagem deve ser confirmada e o worker de pendências deve continuar o fluxo.

### AC-007 — Falha transitória

Dado que o banco ou o optimistic locking falhe de modo transitório antes do commit, quando o consumer tentar processar a mensagem, então não deve confirmar o SQS, não deve deixar efeito financeiro parcial e deve aplicar o backoff aprovado.

### AC-008 — Falha permanente e DLQ

Dado um envelope inválido ou uma mensagem que excedeu cinco tentativas, quando o consumer classificar a falha como permanente, então não deve aplicar saldo/ledger, deve encaminhar a mensagem à `wager-transactions-dlq.fifo` e deve registrar a causa.

### AC-009 — Conflito de payload

Dado um `messageId` já registrado com determinado `payloadHash`, quando chegar o mesmo `messageId` com conteúdo diferente, então o consumer deve rejeitar o conflito sem chamar o caso de uso financeiro novamente e encaminhar o diagnóstico conforme a política de falha permanente.

### AC-010 — Shutdown seguro

Dado que o processo receba `SIGTERM` durante o processamento, quando o shutdown ocorrer, então mensagens com commit confirmado podem ser confirmadas, mensagens não concluídas devem permanecer disponíveis para redelivery e nenhum efeito parcial pode ser confirmado.

### AC-011 — Compatibilidade HTTP

Dado que uma mesma operação seja submetida por HTTP e por SQS com chaves de negócio distintas ou iguais, quando ambas forem processadas, então o comportamento do HTTP existente deve permanecer estável e a consistência financeira deve ser preservada pelas regras de idempotência e unicidade já existentes.

## 9. Casos de erro e edge cases

- `messageId` ausente, vazio ou inválido → falha permanente, sem efeito financeiro, com diagnóstico e DLQ.
- `type` desconhecido → falha permanente, sem chamar o caso de uso financeiro.
- `occurredAt` inválido → falha permanente, sem alterar saldo.
- `data` ausente ou com dinheiro inválido → falha permanente, sem criar `WagerTransaction` financeira.
- mesmo `(consumerName, messageId)` com mesmo hash → replay confirmado sem novo efeito.
- mesmo `(consumerName, messageId)` com hash diferente → conflito permanente.
- Inbox criado, mas falha antes do commit → redelivery deve poder processar novamente sem registro órfão confirmado.
- commit concluído e crash antes do ack → redelivery segura e idempotente.
- `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` persistido → ack após commit.
- falha transitória antes do commit → sem ack; retry com backoff aprovado.
- quinta falha transitória → encaminhamento para DLQ conforme a configuração de redrive.
- falha ao falar com SQS durante shutdown → não confirmar artificialmente; deixar a mensagem para redelivery quando possível.
- múltiplas instâncias consumindo a mesma mensagem → no máximo um efeito financeiro.
- wallets diferentes em paralelo → não usar lock global; manter paralelismo permitido pelo banco.
- falha de Outbox na mesma Unit of Work → reverter Inbox, transação, wallet e ledger juntos.
- eventos da Outbox não são publicados externamente nesta feature.

## 10. Fora de escopo desta feature

- Implementar o publisher externo da Outbox, seus consumers ou contratos de eventos além do que já é persistido.
- Criar novas regras financeiras ou um segundo caso de uso para SQS.
- Alterar o contrato HTTP existente.
- Reconciliação, consultas públicas de transação/ledger e autenticação.
- Teste de carga completo com três instâncias, embora a infraestrutura seja preparada para testes de concorrência e redelivery.
- Retenção/limpeza automática de Inbox ou Outbox além da configuração necessária para esta feature.
- Alterar o `README.md` ou implementar deploy.

## 11. Suposições e perguntas abertas

- [x] A próxima feature foi interpretada como a entrada assíncrona por SQS com Inbox persistente, após a implementação síncrona de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- [x] O consumer usará exatamente `ProcessWagerTransactionUseCase`, sem duplicar regra financeira.
- [x] As filas desta fatia são `wager-transactions.fifo` e `wager-transactions-dlq.fifo`.
- [x] O Inbox será deduplicado por `(consumerName, messageId)` e protegido por constraint persistente.
- [x] O `ack` só ocorrerá depois do commit; crash entre commit e ack será tratado como redelivery idempotente.
- [x] Resultados de negócio persistidos, inclusive rejeição e pendência, são confirmados; falhas transitórias não são confirmadas.
- [x] Falhas transitórias usam cinco tentativas com backoff de `30s`, `1m`, `2m`, `4m` e `5m`, seguindo para DLQ depois do limite.
- [x] `messageId` e `idempotencyKey` são campos distintos: o primeiro deduplica entrega no Inbox; o segundo preserva a idempotência financeira.

### Respostas fundamentadas no README e na arquitetura

- [x] O README define as filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`.
- [x] O README exige distinção entre erros de negócio, transitórios e permanentes: negócio deve receber `ack`, transitório deve usar retry/backoff e permanente deve seguir para DLQ.
- [x] As decisões aprovadas na Spec do Produto definem cinco tentativas transitórias com backoff de `30s`, `1m`, `2m`, `4m` e `5m`; depois disso a mensagem deve seguir para a DLQ.
- [x] O README exige Inbox persistente com unicidade por `(consumerName, messageId)`, ack somente após commit e devolução de visibilidade durante `SIGTERM` quando necessário.
- [x] A arquitetura define no Inbox `consumer_name`, `message_id`, `payload_hash`, `received_at`, `processed_at` e `UNIQUE(consumer_name, message_id)`; qualquer campo adicional precisa de migration.

### Sugestões para as decisões ainda não definidas

- [x] **`consumerName`:** usar uma constante configurável com valor `wager-transaction-consumer-v1`. Todas as instâncias devem usar exatamente o mesmo valor; uma mudança de versão deve ser intencional, pois altera a chave de deduplicação do Inbox.
- [x] **DLQ:** usar a redrive policy nativa do SQS/LocalStack, com `maxReceiveCount = 5`, deixando o broker mover a mensagem para `wager-transactions-dlq.fifo`. O consumer deve apenas classificar o erro, confirmar rejeições de negócio e não apagar falhas transitórias.
- [x] **Diagnóstico do Inbox:** adicionar `attempts`, `last_error_code`, `last_error_at` e `processed_at`. `processed_at` representa o instante do commit bem-sucedido. O payload financeiro completo não será armazenado; `payload_hash` e códigos estruturados serão usados para investigação.
- [x] **Estado do Inbox:** usar os estados `PROCESSING`, `PROCESSED`, `FAILED_RETRYABLE` e `FAILED_PERMANENT`, com atualização atômica e retenção configurável.

As quatro decisões acima foram aprovadas por Marcos e passam a orientar o plano, as migrations e a implementação desta feature.

As perguntas abertas não devem ser decididas silenciosamente durante a implementação. Se alguma resposta alterar o contrato de mensageria ou o schema persistente, deve ser registrada antes do plano e das tarefas.

## 12. Definition of Done desta feature

- [ ] Esta Spec foi revisada e aprovada.
- [ ] O envelope `WagerTransactionRequested` é validado na borda SQS.
- [ ] O consumer reutiliza `ProcessWagerTransactionUseCase`.
- [ ] Inbox persistente com unicidade `(consumerName, messageId)` está implementado.
- [ ] Inbox, transação, wallet, ledger e Outbox são atômicos.
- [ ] Mensagens processadas/rejeitadas/pendentes só recebem ack depois do commit.
- [ ] Redelivery e crash entre commit e ack não duplicam efeitos.
- [ ] Falhas transitórias respeitam cinco tentativas e o backoff aprovado.
- [ ] Falhas permanentes são encaminhadas à DLQ sem efeito financeiro.
- [ ] Shutdown devolve ou conclui mensagens em voo com segurança.
- [ ] Logs estruturados e métricas mínimas permitem diagnosticar duplicatas, retries e DLQ.
- [ ] Testes com PostgreSQL e LocalStack/MiniStack cobrem atomicidade, redelivery, concorrência, retry, DLQ e shutdown.
- [ ] A regressão do processamento HTTP e das operações financeiras passa.
- [ ] Eu revisei e aprovei antes de criar o plano e iniciar a implementação.
