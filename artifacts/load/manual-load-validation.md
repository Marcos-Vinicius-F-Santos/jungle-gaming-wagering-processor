# Load report — manual-load-validation

- Status: passed
- Generated at: 2026-10-17T15:18:41.067Z
- Instances: 3
- Database: postgresql://wagering:wagering@127.0.0.1:26432/wagering
- Broker: http://127.0.0.1:26566

## Scenarios

### distributed-throughput

- Status: passed
- Warmup: 1s
- Measurement: 1s
- Drain: 273ms
- Sent / processed / failed: 4 / 4 / 0
- Invariants: passed
- Queue drained: yes
- sqs_send_latency_ms p50/p95/p99: 3.469400000000178 / 4.991200000000163 / 4.991200000000163 milliseconds
- Limitations: Contadores de processamento são inferidos a partir da drenagem e serão refinados na matriz completa.

### hot-wallet

- Status: passed
- Warmup: 1s
- Measurement: 1s
- Drain: 14ms
- Sent / processed / failed: 9 / 9 / 0
- Invariants: passed
- Queue drained: yes
- sqs_send_latency_ms p50/p95/p99: 3.2140999999996893 / 3.532799999999952 / 3.532799999999952 milliseconds
- Limitations: Contadores de processamento são inferidos a partir da drenagem e serão refinados na matriz completa.

### replay-redelivery

- Status: passed
- Warmup: 1s
- Measurement: 1s
- Drain: 268ms
- Sent / processed / failed: 7 / 7 / 0
- Invariants: passed
- Queue drained: yes
- sqs_send_latency_ms p50/p95/p99: 3.2534999999998035 / 4.627300000000105 / 4.627300000000105 milliseconds
- Limitations: Contadores de processamento são inferidos a partir da drenagem e serão refinados na matriz completa.

### outbox-pressure

- Status: passed
- Warmup: 1s
- Measurement: 1s
- Drain: 267ms
- Sent / processed / failed: 7 / 7 / 0
- Invariants: passed
- Queue drained: yes
- sqs_send_latency_ms p50/p95/p99: 3.119199999999182 / 3.292199999999866 / 3.292199999999866 milliseconds
- Limitations: Contadores de processamento são inferidos a partir da drenagem e serão refinados na matriz completa.


## Limitations

- A execução mede o caminho SQS/Inbox/Outbox; latência HTTP não é coletada por estes cenários.
- CPU e memória do host não são coletadas automaticamente nesta primeira versão do runner.
- A taxa observada depende dos limites locais de PostgreSQL, LocalStack, Docker e do host.
