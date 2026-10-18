#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §47: 새 경로(Kafka 내부망 + 메타데이터 전송, §46)에서 부하 격자. A1(같은 소스 Fabric) 과 BE(Serializer, ε .1/.75).
# 100/200/300/400 TPS, s 1.15, 긴급 0, 3바퀴(순서를 섞고 시스템 순서를 바꾼다). 결과: results/load3-t<t>
cd $(cd "$HERE/../zipfbench" && pwd)
unset PROCESSOR_ABORT_MODE PROCESSOR_ABORT_DELAY PROCESSOR_BROKERS KAFKA_BROKERS KAFKA_INCOMING_FORMAT
F='^\[.*== |^\| users|실패|건너뜀'
drop() { MSYS_NO_PATHCONV=1 docker run --rm --privileged alpine sh -c 'sync; echo 1 > /proc/sys/vm/drop_caches' >/dev/null 2>&1; }
one() { echo "### load3-t$2 r$1 [$3] $(date +%H:%M)"; env RUN_ID=load3-t$2 TPS=$2 ZIPF_S=1.15 SYSTEMS="$3" URGENT_LIST=0 REPS=1 REP_START=$1 ./userbench.sh 2>&1 | grep -E "$F"; drop; }
for t in 300 100 400 200; do one 1 $t "A1 BE"; done
for t in 200 400 100 300; do one 2 $t "BE A1"; done
for t in 100 300 200 400; do one 3 $t "A1 BE"; done
echo "ALL-DONE $(date +%H:%M)"
