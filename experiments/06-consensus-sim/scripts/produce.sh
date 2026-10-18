#!/bin/bash
# Kafka 컨테이너 안에서 돈다. 표준 입력의 한 줄(표식)마다 abort 기록 하나를 올리고,
# 표식과 기록의 timestamp를 /tmp/fig57_<이름>.rec 에 남긴다.
# 키를 고정해 한 파티션에만 쌓는다. 그래야 블록이 기록을 순서대로 덮는다.
rec="/tmp/fig57_$1.rec"
: > "$rec"
while read -r tag; do
  ts=$(date +%s%3N)
  echo "$tag $ts" >> "$rec"
  echo "fig57|{\"timestamp\":$ts,\"users\":{\"fig57\":1}}"
done | /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server kafka1:9090 --topic mychannel-abort \
  --property parse.key=true --property 'key.separator=|' \
  --producer-property linger.ms=0 >/dev/null 2>&1
