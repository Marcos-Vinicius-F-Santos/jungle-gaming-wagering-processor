#!/bin/sh
set -eu

region="${AWS_DEFAULT_REGION:-us-east-1}"
main_queue="wager-transactions.fifo"
dead_letter_queue="wager-transactions-dlq.fifo"
events_queue="wager-events.fifo"
events_dead_letter_queue="wager-events-dlq.fifo"

awslocal --region "$region" sqs create-queue \
  --queue-name "$dead_letter_queue" \
  --attributes FifoQueue=true,ContentBasedDeduplication=true >/dev/null 2>&1 || true

awslocal --region "$region" sqs create-queue \
  --queue-name "$main_queue" \
  --attributes FifoQueue=true,ContentBasedDeduplication=true >/dev/null 2>&1 || true

awslocal --region "$region" sqs create-queue \
  --queue-name "$events_dead_letter_queue" \
  --attributes FifoQueue=true,ContentBasedDeduplication=true >/dev/null 2>&1 || true

awslocal --region "$region" sqs create-queue \
  --queue-name "$events_queue" \
  --attributes FifoQueue=true,ContentBasedDeduplication=true >/dev/null 2>&1 || true

main_url="$(awslocal --region "$region" sqs get-queue-url --queue-name "$main_queue" --query QueueUrl --output text)"
dead_letter_url="$(awslocal --region "$region" sqs get-queue-url --queue-name "$dead_letter_queue" --query QueueUrl --output text)"
events_url="$(awslocal --region "$region" sqs get-queue-url --queue-name "$events_queue" --query QueueUrl --output text)"
awslocal --region "$region" sqs set-queue-attributes \
  --queue-url "$main_url" \
  --attributes file:///etc/localstack/init/ready.d/redrive-policy.json >/dev/null

awslocal --region "$region" sqs set-queue-attributes \
  --queue-url "$events_url" \
  --attributes file:///etc/localstack/init/ready.d/events-redrive-policy.json >/dev/null
