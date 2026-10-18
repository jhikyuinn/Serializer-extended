#!/bin/bash
# [③ Kafka VM] Kafka 브로커 3 + ZooKeeper 3 + MongoDB + 프로세서를 띄운다.
# 브로커는 다른 VM(오더러, Caliper, s-node, w-node)이 $KAFKA_IP:9091~9093 으로 붙고,
# 같은 VM 의 프로세서는 도커 내부망 kafka1:9090 으로 붙는다(§45~§46).
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
cd "$WORK/Serializer/kafka"
D="sudo docker"
cat > .env <<EOF
KAFKA_BROKER1=$KAFKA_IP:9091
KAFKA_BROKER2=$KAFKA_IP:9092
KAFKA_BROKER3=$KAFKA_IP:9093
EOF
$D tag "$PROCESSOR_IMAGE" weave-kafka/processor:latest
C="$D compose -f docker-compose.yml -f docker-compose.processor.yml"
$C pull -q zookeeper1 zookeeper2 zookeeper3 kafka1 kafka2 kafka3 mongo || true
$C up -d zookeeper1 zookeeper2 zookeeper3 kafka1 kafka2 kafka3 mongo
# 처음에는 ZooKeeper 가 늦어 브로커가 죽을 수 있다. 다시 올린다
for i in 1 2 3; do
  sleep 20
  [ "$($D ps --format '{{.Names}}' | grep -c 'kafka-kafka[123]-1')" = 3 ] && break
  $C up -d kafka1 kafka2 kafka3
done
# 채널 목록: s-node 는 프로세서에서 채널을 받고, 프로세서는 Fabric 이 contribution-topic 에 올린 메시지로 안다.
# 이 Fabric 은 그 메시지를 내보내지 않으므로 직접 넣는다(로컬과 같다, NOTES §7). 없으면 s-node 가 커미티를 버린다
echo '{"type":1,"channel":"mychannel","block":0,"tx":0,"members":2}' | \
  $D exec -i kafka-kafka1-1 kafka-console-producer.sh --bootstrap-server kafka1:9090 --topic contribution-topic >/dev/null 2>&1 || true
$C up -d --no-deps processor
sleep 15
$D logs kafka-processor-1 2>&1 | grep -E "Kafka brokers|abort mode|Ordering algorithm" || { echo "프로세서 로그를 확인한다: $D logs kafka-processor-1" >&2; exit 1; }
echo "role-kafka 끝: 브로커 $KAFKA_IP:9091~9093"
