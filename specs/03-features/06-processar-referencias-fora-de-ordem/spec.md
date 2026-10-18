# Spec da Feature — Processar referências fora de ordem

Status: Aprovada em 2026-10-16
Projeto: Distributed Wagering Processor  
Onde vive no código: `src/modules/wagering/`, worker de referências pendentes, persistência de `WagerTransaction` e Outbox  
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature anterior: [`../05-processar-sqs-inbox/spec.md`](../05-processar-sqs-inbox/spec.md)

> Esta feature formaliza e completa o fluxo de referências fora de ordem que já possui uma base parcial no código. Ela não deve criar um segundo caso de uso financeiro nem duplicar o processamento HTTP/SQS.

## 1. Objetivo

Permitir que uma operação dependente seja recebida antes da transação que ela referencia, sem perder a operação, aplicar efeito financeiro prematuro ou exigir que o provedor reenvie indefinidamente a mensagem.

Quando a referência ainda não estiver disponível, o sistema deve persistir a operação como `PENDING_REFERENCE`, registrar a pendência na Outbox e agendar o mesmo registro para reprocessamento. Quando a referência aparecer, o sistema deve executar a operação original exatamente uma vez, dentro da mesma Unit of Work usada pelo fluxo síncrono.

Se a referência não aparecer dentro do TTL aprovado, a operação deve terminar como `REJECTED` com `REFERENCE_NOT_FOUND`, permanecer auditável e produzir o evento correspondente.

O fluxo deve permanecer correto com HTTP, SQS, redelivery, reinício do processo, múltiplas instâncias, replay, falha entre tentativas e concorrência sobre a mesma wallet.

## 2. Como funciona hoje

O sistema já possui:

- `WagerTransaction.status = PENDING_REFERENCE`;
- `pendingSince`, `nextAttemptAt` e `pendingAttempts` persistidos;
- `ReferencePendingPolicy` com TTL de 15 minutos e backoff de `30s`, `1m`, `2m`, `4m` e `7m`;
- `PendingReferenceWorker`, que consulta registros vencidos e chama `ProcessWagerTransactionUseCase.reprocessPendingReference`;
- validação de referência por provider, player, wallet, moeda, rodada, kind e valor quando aplicável;
- eventos `WagerTransactionPendingReference` e `WagerTransactionRejected` na Outbox;
- integração SQS que confirma a mensagem depois de persistir a pendência.

Esta feature transforma essa base em um contrato completo e seguro para produção. Em especial, o reprocessamento deve ser protegido contra duas instâncias selecionarem a mesma pendência, o reinício não pode perder agenda, o registro deve ser reavaliado dentro da transação atual e cada transição deve ser atômica.

O fluxo financeiro continua concentrado em `ProcessWagerTransactionUseCase`. O worker apenas seleciona pendências e solicita o reprocessamento da operação persistida.

## 3. Requisitos funcionais

### FR-001 — Identificar operações dependentes

QUANDO uma operação `WIN` possuir `referenceExternalTransactionId`, ou uma operação `REFUND` ou `ROLLBACK` for submetida

O SISTEMA DEVE resolver a referência por `(providerId, referenceExternalTransactionId)` antes de aplicar qualquer alteração de saldo.

`WIN` sem referência continua sendo processada conforme a regra existente. `REFUND` e `ROLLBACK` continuam exigindo referência no contrato de entrada.

### FR-002 — Persistir referência ausente

QUANDO a referência ainda não existir

O SISTEMA DEVE persistir a operação como `PENDING_REFERENCE`, preencher `pendingSince`, `nextAttemptAt` e `pendingAttempts`, sem alterar wallet, versão ou ledger.

A criação da transação, a marcação da pendência e o evento `WagerTransactionPendingReference` devem confirmar ou reverter juntos na mesma transação SQL.

O evento de pendência deve ser criado uma única vez para a entrada da operação no estado `PENDING_REFERENCE`; cada tentativa de consulta não deve gerar evento duplicado.

### FR-003 — Agendar com backoff persistente

QUANDO uma operação entrar ou permanecer em `PENDING_REFERENCE`

O SISTEMA DEVE calcular a próxima tentativa usando a política aprovada:

| Tentativa | Atraso mínimo após a tentativa |
|---:|---:|
| inicial | `30s` |
| 1 | `1m` |
| 2 | `2m` |
| 3 | `4m` |
| 4 | `7m` |

Nenhuma tentativa pode ser agendada depois de `pendingSince + 15 minutos`. A agenda deve estar no PostgreSQL, e não somente em memória, para sobreviver a restart e permitir que outra instância continue o trabalho.

### FR-004 — Reprocessar a mesma operação

QUANDO uma pendência estiver vencida e a referência estiver disponível e compatível

O SISTEMA DEVE reidratar a mesma `WagerTransaction`, associar `referenceTransactionId`, executar o mesmo caso de uso financeiro e concluir a operação como `PROCESSED`.

O reprocessamento não pode criar uma nova `WagerTransaction`, alterar `idempotencyKey`, recalcular uma nova operação de negócio ou depender de uma nova mensagem SQS.

### FR-005 — Processar a referência recuperada com atomicidade

QUANDO o reprocessamento puder ser concluído

O SISTEMA DEVE confirmar na mesma Unit of Work:

- a associação da referência interna;
- a transição para `PROCESSED`;
- a alteração da wallet quando aplicável;
- o lançamento imutável do ledger quando aplicável;
- `processedAt` e o snapshot de saldo para replay;
- `WagerTransactionProcessed`;
- `WalletBalanceChanged`, somente quando o saldo mudar.

Uma falha em qualquer etapa deve reverter todas as alterações da tentativa.

### FR-006 — Rejeitar referência incompatível

QUANDO a referência existir, mas estiver incompatível

O SISTEMA DEVE rejeitar a operação sem alterar saldo ou ledger, persistir `REFERENCE_NOT_COMPATIBLE` e enfileirar `WagerTransactionRejected` na mesma transação.

São incompatibilidades, entre outras:

- provider diferente;
- player ou wallet diferente;
- moeda ou rodada diferente;
- kind não permitido;
- valor diferente quando a operação exigir igualdade;
- referência terminal em estado diferente de `PROCESSED`;
- referência já revertida de forma incompatível com a regra de reversão única.

### FR-007 — Expirar referência não encontrada

QUANDO `pendingSince + 15 minutos` for atingido sem uma referência processável

O SISTEMA DEVE tornar a operação `REJECTED` com `failureCode = REFERENCE_NOT_FOUND`, limpar os campos de agenda, manter a transação auditável e persistir `WagerTransactionRejected` atomicamente.

A expiração é terminal. O worker não deve continuar reagendando nem reabrir a operação depois dessa transição.

### FR-008 — Proteger concorrência entre workers

QUANDO duas ou mais instâncias selecionarem a mesma pendência

O SISTEMA DEVE garantir que no máximo uma instância aplique a transição ou o efeito financeiro. A solução deve usar a proteção persistente do PostgreSQL, com reconsulta/lock da pendência dentro da Unit of Work e verificação de que ela ainda está vencida e em `PENDING_REFERENCE`.

Uma instância que encontrar a operação já processada, rejeitada ou reagendada por outra deve sair sem aplicar novo efeito e sem criar evento duplicado.

Não deve existir lock global que impeça o processamento paralelo de wallets diferentes.

### FR-009 — Preservar idempotência e replay

QUANDO a mesma operação pendente for reenviada por HTTP ou redelivery SQS

O SISTEMA DEVE preservar a transação original e retornar o estado persistido, sem criar nova operação, novo ledger ou novos efeitos financeiros.

Quando a operação já estiver `PROCESSED` ou `REJECTED`, o replay deve refletir o resultado original. Quando estiver pendente, o replay deve refletir `PENDING_REFERENCE` e a próxima tentativa persistida.

Payload diferente para a mesma chave de idempotência ou identificador externo continua sendo conflito, não uma nova tentativa de resolver a referência.

### FR-010 — Integrar com HTTP e SQS

O fluxo HTTP deve continuar retornando `202 Accepted` quando a pendência for criada e não deve aguardar o worker.

O fluxo SQS deve confirmar a mensagem somente depois do commit que persistir `PENDING_REFERENCE`. O worker posterior não deve depender do receipt handle, da Inbox ou da disponibilidade da mensagem original no broker.

Falhas transitórias do banco ou de optimistic locking devem manter a operação disponível para nova tentativa sem confirmar uma Unit of Work incompleta.

### FR-011 — Observar o ciclo da pendência

O SISTEMA DEVE registrar logs estruturados e métricas mínimas para:

- entrada em `PENDING_REFERENCE`;
- tentativa de reprocessamento;
- sucesso após referência recuperada;
- referência incompatível;
- expiração por `REFERENCE_NOT_FOUND`;
- conflito de lock/retry;
- quantidade e idade das pendências vencidas.

Logs não devem conter o payload financeiro completo, credenciais ou receipt handle SQS.

## 4. Regras de negócio

### BR-001 — Referências permitidas

- `WIN` pode referenciar uma `BET` `PROCESSED` da mesma rodada.
- `REFUND` exige uma `BET` `PROCESSED` e reverte integralmente seu valor.
- `ROLLBACK` pode referenciar uma `BET`, `WIN` ou `REFUND` `PROCESSED` e aplica a direção inversa.
- `LOSS`, `OPENING`, `REJECTED`, `FAILED` e operações ainda pendentes não são referências processáveis.
- `OPENING` continua interno e não pode ser submetido pelo provedor.

### BR-002 — Compatibilidade da referência

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao mesmo provider, player, wallet, moeda e rodada da operação dependente.

Para `REFUND` e `ROLLBACK`, o valor deve ser igual ao da referência. Reversão parcial permanece fora de escopo. Para `WIN`, a regra de valor segue o contrato já aprovado da feature de `WIN`.

### BR-003 — Política de pendência

- `pendingSince` é definido na primeira persistência como `PENDING_REFERENCE`.
- Redelivery HTTP/SQS não reinicia `pendingSince`.
- O backoff é `30s`, `1m`, `2m`, `4m` e `7m`.
- O TTL total é de 15 minutos.
- Uma tentativa vencida deve primeiro verificar se a referência já apareceu.
- Ao expirar, a operação torna-se terminal e não pode voltar a `PENDING_REFERENCE`.

### BR-004 — Estados e transições

As transições válidas desta feature são:

```text
PENDING ───────────────► PENDING_REFERENCE ─────► PROCESSED
   │                              │                 
   └──────────────────────────────┴──────────────► REJECTED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Nenhum worker pode aplicar efeito a uma operação terminal.

### BR-005 — Atomicidade e ledger

Enquanto a referência não for resolvida, não pode haver alteração de saldo, versão ou ledger. Quando houver efeito financeiro, wallet, transação, ledger e Outbox devem confirmar ou reverter juntos.

O ledger continua imutável, com no máximo um lançamento por `(walletId, transactionId)`, e o saldo deve permanecer não negativo.

### BR-006 — Reversão única

Uma transação de referência não pode receber mais de uma reversão direta. A proteção deve funcionar com múltiplos workers, múltiplas instâncias e redelivery. O replay da própria reversão continua permitido.

### BR-007 — Precisão e idempotência

Valores continuam sendo strings decimais exatas, persistidos como `NUMERIC(19,2)`. O `payloadHash` continua sendo SHA-256 do JSON canônico dos campos de negócio. Esta feature não altera o contrato de idempotência já existente.

## 5. Contratos e comportamento externo

Não será criado endpoint novo. O endpoint existente `POST /wagering/transactions` mantém:

- `202 Accepted` quando a referência estiver ausente e a operação for persistida como `PENDING_REFERENCE`;
- `200 OK` para replay idempotente da mesma pendência;
- `201 Created` somente quando a operação for processada no próprio request;
- `422 Unprocessable Content` para referência incompatível ou expiração já concluída;
- `409 Conflict` para conflito de idempotência, identificador externo ou reversão duplicada;
- `503 Service Unavailable` para falha transitória que não permitiu confirmar a Unit of Work.

A consulta existente de transação deve permitir observar `PENDING_REFERENCE`, `nextAttemptAt`, `pendingSince` e o estado final, conforme o contrato já implementado.

Os eventos persistidos na Outbox são:

- `WagerTransactionPendingReference`, uma vez ao entrar na pendência;
- `WagerTransactionProcessed`, ao resolver com sucesso;
- `WagerTransactionRejected`, ao detectar incompatibilidade ou expirar;
- `WalletBalanceChanged`, somente se o reprocessamento alterar o saldo.

A publicação externa desses eventos permanece fora desta feature e será tratada pela feature de Transactional Outbox.

## 6. Critérios de aceite

### AC-001 — Pendência sem efeito financeiro

Dado um `WIN`, `REFUND` ou `ROLLBACK` cuja referência ainda não exista, quando a operação for recebida, então ela deve retornar `202`, ser persistida como `PENDING_REFERENCE`, possuir agenda válida, gerar um único evento de pendência e não alterar saldo, versão ou ledger.

### AC-002 — Reprocessamento após chegada da referência

Dado que uma operação esteja pendente e a referência compatível tenha sido persistida como `PROCESSED`, quando o worker executar a pendência vencida, então a mesma transação deve ser processada uma vez, com referência interna vinculada, efeitos financeiros corretos e eventos atômicos.

### AC-003 — Backoff e TTL

Dado que a referência continue ausente, quando o worker executar tentativas consecutivas, então os horários devem respeitar `30s`, `1m`, `2m`, `4m` e `7m`, sem ultrapassar 15 minutos desde `pendingSince`.

### AC-004 — Expiração auditável

Dado que o TTL tenha expirado sem referência processável, quando o worker executar a pendência, então a operação deve se tornar `REJECTED` com `REFERENCE_NOT_FOUND`, gerar um único evento de rejeição e não alterar saldo ou ledger.

### AC-005 — Referência incompatível

Dado que a referência exista, mas pertença a outro contexto, kind inválido, valor incompatível ou estado não processável, quando a pendência for reprocessada, então ela deve ser rejeitada com `REFERENCE_NOT_COMPATIBLE`, sem efeito financeiro e sem novo agendamento.

### AC-006 — Concorrência entre instâncias

Dado que duas instâncias processem a mesma pendência simultaneamente, quando ambas tentarem resolver a referência, então no máximo uma deve alterar wallet, transação, ledger ou Outbox; a outra deve observar o estado persistido e sair sem duplicar efeitos.

### AC-007 — Reinício do worker

Dado que o processo seja encerrado depois de uma operação entrar em `PENDING_REFERENCE`, quando uma nova instância iniciar, então ela deve recuperar a operação pela agenda persistida e continuar o ciclo sem reiniciar o TTL.

### AC-008 — Replay HTTP/SQS

Dado que a mesma operação seja reenviada enquanto estiver pendente ou depois de concluída, quando o request ou redelivery for processado, então o sistema deve retornar o estado original sem criar nova operação, ledger ou evento financeiro duplicado.

### AC-009 — Falha transacional

Dado que ocorra falha ao persistir a transação, wallet, ledger ou Outbox durante o reprocessamento, quando a Unit of Work terminar, então nenhuma parte da transição deve permanecer confirmada e a operação deve continuar elegível para nova tentativa segura.

### AC-010 — Regressão das entradas existentes

Dado que uma operação normal seja recebida por HTTP ou SQS, quando não houver referência pendente, então BET, WIN, LOSS, REFUND e ROLLBACK devem manter os comportamentos, contratos, idempotência, ledger e Outbox já aprovados.

## 7. Casos de erro e edge cases

- referência ausente na primeira tentativa → `PENDING_REFERENCE`, `202`, sem efeito financeiro;
- `WIN` sem referência → segue o fluxo síncrono já aprovado;
- `REFUND` ou `ROLLBACK` sem referência no payload → erro de validação antes da persistência financeira;
- referência existente em `PENDING`, `PENDING_REFERENCE` ou `FAILED` → seguir a decisão aprovada para referências não processáveis; não aplicar efeito parcial;
- referência `REJECTED` → rejeitar a dependente como incompatível;
- referência de outro provider, player, wallet, moeda ou rodada → rejeitar como incompatível;
- `REFUND` de `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` → rejeitar como incompatível;
- `ROLLBACK` de `LOSS`, `OPENING`, `ROLLBACK` ou operação não processada → rejeitar como incompatível;
- valor divergente em `REFUND`/`ROLLBACK` → rejeitar como incompatível;
- referência aparece entre a seleção do worker e o lock da Unit of Work → reconsultar e processar o estado mais recente;
- duas instâncias vencem a mesma pendência → lock/reconsulta garante no máximo uma transição;
- crash antes do commit → a pendência e a tentativa permanecem elegíveis;
- crash depois do commit → a próxima execução observa estado terminal e não duplica efeito;
- expiração concorrente com chegada da referência → a Unit of Work serializada decide uma única transição; nunca haverá `PROCESSED` e `REJECTED` confirmados para a mesma operação;
- reinício do processo → `pendingSince` e `nextAttemptAt` são recuperados do banco;
- payload diferente para a mesma idempotency key → conflito, sem reabrir a pendência;
- publicação externa da Outbox indisponível → não faz parte do resultado do worker nesta feature; o evento permanece persistido.

## 8. Fora de escopo desta feature

- Publicador externo da Outbox, consumers de eventos ou garantia de entrega exatamente uma vez.
- Novo endpoint ou alteração do contrato público de consulta.
- Alteração das regras financeiras de BET, WIN, LOSS, REFUND ou ROLLBACK.
- Reversão parcial, double-entry bookkeeping ou reconciliação.
- Limpeza automática/retention job de transações, Inbox ou Outbox.
- Autenticação, autorização, deploy ou configuração de produção.
- Teste de carga completo com três instâncias; serão exigidos testes de concorrência focados no worker.
- Alteração do `README.md`.

## 9. Suposições e perguntas abertas

### Decisões já definidas pelo produto e pela arquitetura

- [x] TTL de 15 minutos desde a primeira persistência como `PENDING_REFERENCE`.
- [x] Backoff de `30s`, `1m`, `2m`, `4m` e `7m`, sem agendar além do TTL.
- [x] Agenda persistida no PostgreSQL; restart não reinicia o TTL.
- [x] O worker reutiliza `ProcessWagerTransactionUseCase` e a mesma Unit of Work financeira.
- [x] A mensagem SQS que gerou a pendência recebe ack após o commit; o reprocessamento posterior não depende do broker.
- [x] Eventos da Outbox são persistidos transacionalmente, mas não publicados externamente nesta feature.
- [x] A unidade de concorrência continua sendo `walletId`, sem lock global.

### Decisões aprovadas antes do plano

- [x] **Proteção de concorrência:** usar `SELECT ... FOR UPDATE SKIP LOCKED` para selecionar candidatos e reconsultar o registro dentro da Unit of Work. A seleção será em lote, mas o lock definitivo ocorrerá por id antes da decisão e do efeito financeiro, sem lease em memória.
- [x] **Referência ainda não terminal:** tratar uma referência existente em estado não terminal como pendência, em vez de rejeitar imediatamente; estados terminais diferentes de `PROCESSED` serão incompatíveis.
- [x] **Operação do worker:** manter lote padrão de 50 e polling configurável de 1 segundo, com métricas de duração e quantidade de registros vencidos. O polling será apenas um mecanismo de despertar; a fonte da verdade continuará sendo a agenda persistida.
- [x] **Falha de reprocessamento:** manter a operação em `PENDING_REFERENCE` quando a falha for transitória de infraestrutura/lock e deixar a próxima agenda disponível; falha de regra será terminal e auditável.

As decisões acima foram aprovadas e passam a orientar o plano, as tarefas e a implementação desta feature.

## 10. Definition of Done desta feature

- [x] Esta Spec foi revisada e aprovada.
- [x] O ciclo `PENDING_REFERENCE` está documentado para HTTP, SQS e worker.
- [x] Referências ausentes não alteram saldo, versão ou ledger.
- [x] O backoff e o TTL são persistentes e sobrevivem a restart.
- [x] O reprocessamento reutiliza a mesma transação e o mesmo caso de uso.
- [x] Concorrência entre múltiplos workers não duplica efeitos ou eventos.
- [x] Referências recuperadas geram wallet, ledger e Outbox atomicamente.
- [x] Referências incompatíveis e expiradas são rejeitadas com códigos estáveis.
- [x] Replay, conflito, redelivery e crash recovery estão cobertos.
- [x] Logs e métricas permitem acompanhar idade, tentativas, sucesso e expiração.
- [x] A regressão dos fluxos HTTP e SQS existentes passa.
- [x] O plano e as tarefas foram criados após a aprovação formal desta Spec.
