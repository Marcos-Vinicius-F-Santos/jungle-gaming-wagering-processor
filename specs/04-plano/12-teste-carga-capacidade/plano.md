# Plano de Implementação — Teste de carga e capacidade operacional

Spec relacionada: [`../../03-features/12-teste-carga-capacidade/spec.md`](../../03-features/12-teste-carga-capacidade/spec.md)  
Arquitetura relacionada: [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)  
README de referência: [`../../../README.md`](../../../README.md)  
Feature anterior: [`../11-resiliencia-sqs-inbox/plano.md`](../11-resiliencia-sqs-inbox/plano.md)  

Status: Implementação verificada — aguardando aprovação final  

## 1. Objetivo do plano

Implementar um comando de carga reproduzível que exercite o caminho real HTTP/SQS/Inbox/financeiro/Outbox com PostgreSQL, LocalStack e três instâncias da aplicação, produzindo métricas de capacidade e verificando as invariantes financeiras ao final de cada cenário.

O plano trata o teste como uma ferramenta operacional isolada. Nenhuma etapa altera regras de negócio, contratos públicos, políticas de retry/DLQ, TTL de referências ou a implementação financeira existente.

## 2. Decisões aplicadas

- O comando público será `bun run test:load`.
- A execução padrão terá 30 segundos de aquecimento e 2 minutos de medição por cenário.
- A infraestrutura será real: PostgreSQL, LocalStack/MiniStack e três instâncias independentes.
- Os cenários mínimos serão throughput distribuído, wallet quente, replay/redelivery e Outbox sob carga.
- Cada execução terá `runId` e cada cenário terá `scenarioId`, evitando dados residuais e permitindo correlação.
- Não haverá meta fixa de RPS; taxa, concorrência e duração serão configuráveis e registradas no relatório.
- Falha de invariante será bloqueadora, mesmo quando throughput ou latência forem bons.
- O relatório terá uma forma estruturada para automação e um resumo legível para revisão humana.
- Fault injection será usado somente onde necessário para redelivery controlado, sempre desabilitado por padrão.
- Health ficará aberto e autenticação continuará fora do escopo.

## 3. Baseline e impacto

### Já existente

- Processamento financeiro HTTP com idempotência, optimistic locking, ledger e Outbox.
- Consumer SQS com Inbox persistente, claim/lease, redelivery, retry, DLQ e shutdown seguro.
- Compose de resiliência com PostgreSQL, LocalStack e três instâncias.
- Harness `bun run test:resilience` com dados isolados e validação de invariantes.
- Logs, métricas, health checks e consultas de Inbox/Outbox já disponíveis.

### A complementar

- contrato de configuração do gerador de carga;
- gerador controlado de operações válidas e replays;
- medição monotônica de latência e cálculo de percentis;
- coleta de throughput, erros, retries, conflitos, redelivery e Outbox lag;
- relatório JSON/Markdown ou equivalente documentado;
- quatro cenários de carga com drenagem e validação final;
- execução interrompível e limpeza limitada ao `runId`.

### A preservar

- `Money`, saldo, ledger e regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
- idempotência por chave e transação externa;
- ack após commit e recuperação de Inbox;
- classificação de falhas, backoff, visibilidade, retry e DLQ;
- payloads, contratos HTTP, eventos Outbox e README.

## 4. Desenho técnico

### 4.1 Configuração

Criar um contrato de configuração validado, com defaults seguros:

| Configuração | Finalidade |
|---|---|
| `LOAD_SCENARIO` | cenário único ou `all` |
| `LOAD_WARMUP_SECONDS` | aquecimento, default `30` |
| `LOAD_DURATION_SECONDS` | medição, default `120` |
| `LOAD_DRAIN_TIMEOUT_SECONDS` | espera pós-geração |
| `LOAD_CONCURRENCY` | workers do gerador |
| `LOAD_RATE_PER_SECOND` | taxa alvo opcional |
| `LOAD_RUN_ID` | identificador explícito ou UUID gerado |
| `LOAD_REPORT_DIR` | diretório de resultados |
| `LOAD_KEEP_ENVIRONMENT` | preservar ambiente para diagnóstico |

Valores negativos, zero onde não permitido, duração ilimitada ou taxa sem limite devem ser rejeitados antes de iniciar a carga.

### 4.2 Geração e rastreamento

O gerador deve criar wallets e operações dentro do escopo do `runId`, mantendo uma tabela/arquivo de amostras suficiente para validar o resultado sem guardar payload financeiro completo no log. Cada operação deve carregar metadados de correlação fora do payload de negócio.

O relógio de latência deve ser monotônico. Cada amostra deve indicar tipo de operação, cenário, resultado, início, fim e classificação; IDs individuais ficam fora das tags agregadas.

### 4.3 Métricas e percentis

Implementar uma camada de coleta que aceite contadores, durações e gauges. O cálculo deve ser determinístico para uma mesma sequência de amostras, documentando arredondamento, unidade e comportamento quando não houver amostras.

O mínimo de métricas é:

- operações enviadas, aceitas, processadas, rejeitadas, pendentes e falhas;
- throughput de entrada, processamento financeiro e publicação;
- latência HTTP, processamento SQS e Outbox lag;
- p50, p95 e p99 por métrica aplicável;
- retries, redeliveries, replays, lock conflicts e leases recuperadas;
- mensagens na DLQ, backlog e tempo de drenagem;
- invariantes financeiras e contagem de duplicidades.

### 4.4 Infraestrutura

Reutilizar a composição de resiliência quando possível. Adicionar apenas override/configuração de carga para:

- parâmetros de polling e concorrência;
- limites de recursos ou observação de CPU/memória;
- filas e endpoints de diagnóstico;
- isolamento de execução.

Não criar um segundo banco financeiro nem apagar volumes existentes como parte automática do comando.

### 4.5 Cenários

| Cenário | Entrada | Evidência principal |
|---|---|---|
| `distributed-throughput` | operações válidas para wallets distintas | throughput, latência e drenagem |
| `hot-wallet` | operações concorrentes na mesma wallet | lock conflicts, retries e invariantes |
| `replay-redelivery` | replays idempotentes e redelivery controlado | um efeito, custo de replay e Inbox |
| `outbox-pressure` | produção contínua de eventos | backlog, publish rate e Outbox lag |

Cada cenário deve permitir execução isolada e seleção em `LOAD_SCENARIO=...`.

## 5. Fases de implementação

1. Confirmar baseline, dependências, portas e forma de coleta disponível.
2. Definir configuração, modelos de amostra, métricas e relatório.
3. Implementar geração isolada e validador de invariantes.
4. Implementar os quatro cenários sobre a infraestrutura real.
5. Implementar orquestração, drenagem, interrupção e limpeza segura.
6. Executar regressão unitária, integração e resiliência.
7. Executar a carga, registrar resultados e documentar limitações.
8. Auditar Spec ↔ plano ↔ tarefas ↔ código ↔ relatório e aguardar aprovação final.

## 6. Estratégia de testes

### Unitários

- validação de configuração;
- relógio e amostra de latência;
- percentis e unidades;
- classificação de respostas e falhas;
- agregação de métricas;
- serialização do relatório;
- geração de `runId` e isolamento.

### Integração

- criação e consulta de dados de carga no PostgreSQL real;
- envio/consumo no LocalStack real;
- três instâncias compartilhando filas e banco;
- validação de Inbox, wallet, ledger, Outbox e DLQ;
- medição de drenagem e publicação.

### Processo

- execução dos quatro cenários;
- execução de cenário único;
- duas execuções com `runId` diferente;
- interrupção durante geração e preservação de relatório parcial;
- falha de uma dependência antes da medição;
- validação de saída não-zero quando uma invariante falha.

## 7. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Gerador virar gargalo | medir e registrar capacidade do gerador; separar taxa alvo de throughput observado |
| Resultado contaminado por dados antigos | `runId`, filas isoladas e validação de baseline |
| Percentil enganoso por poucas amostras | registrar quantidade de amostras e marcar insuficiência |
| Throughput alto com corrupção financeira | invariantes bloqueadoras após cada cenário |
| Outbox lag não ser observável | coletar backlog e timestamps persistidos, não apenas logs |
| Carga exaurir recursos do host | limites configuráveis, timeout e encerramento seguro |
| Falha mascarada por retries | separar resultado inicial, retry, replay e estado terminal |
| Limpeza apagar dados externos | limpeza por `runId` ou ambiente explicitamente isolado |
| Mudança acidental no negócio | regressão financeira e revisão de diff antes do relatório |

## 8. Critérios para considerar o plano concluído

- FR-001 a FR-011 e AC-001 a AC-010 têm tarefas e evidências objetivas.
- `bun run test:load` executa os quatro cenários com infraestrutura real.
- Cada cenário registra aquecimento, medição, drenagem, throughput e p50/p95/p99.
- Erros, retries, conflitos, DLQ, redelivery e Outbox lag são classificados.
- A invariável financeira é verificada e qualquer violação torna a execução malsucedida.
- A execução é repetível, configurável e isolada por `runId`.
- Relatórios e falhas parciais são preservados sem segredos ou payload financeiro completo.
- Typecheck, build, unitários, integração e resiliência permanecem verdes.
- `README.md` não é alterado nesta entrega sem decisão explícita.
- Spec, plano e tarefas ficam marcados como aguardando aprovação final; nenhuma aprovação é inferida.
