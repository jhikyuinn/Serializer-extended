#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §50: 배치 크기 100/500/1000 × 부하 250/350 TPS × (A1 같은 소스 Fabric, BE Serializer ε .1/.75), smallbank s 1.15, 긴급 0, 3바퀴.
# BatchTimeout 은 크기로 잘리도록 넉넉히(100: 2s, 500: 5s, 1000: 10s). 실행 60초, Caliper 커밋 대기 30초.
# 결과: results/batch-b<B>-t<T>. 끝나면 s-node 활성 전환 수(바쁜 상태의 Lease 2초 점검)를 남긴다.
cd $(cd "$HERE/../zipfbench" && pwd)
unset PROCESSOR_ABORT_MODE PROCESSOR_BROKERS KAFKA_BROKERS KAFKA_INCOMING_FORMAT
export CALIPER_TIMEOUT=30 DURATION=60 ZIPF_S=1.15
F='^\[.*== |^\| users|실패|건너뜀'
drop() { MSYS_NO_PATHCONV=1 docker run --rm --privileged alpine sh -c 'sync; echo 1 > /proc/sys/vm/drop_caches' >/dev/null 2>&1; }
to() { case $1 in 100) echo 2s;; 500) echo 5s;; 1000) echo 10s;; esac; }
one() { # rep batch tps systems
  echo "### batch-b$2-t$3 r$1 [$4] $(date +%H:%M)"
  env RUN_ID=batch-b$2-t$3 BATCH_SIZE=$2 BATCH_TIMEOUT=$(to $2) TPS=$3 SYSTEMS="$4" URGENT_LIST=0 REPS=1 REP_START=$1 ./userbench.sh 2>&1 | grep -E "$F"; drop; }
for i in $(seq 1 10); do docker stop mt$i >/dev/null 2>&1; done
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for c in 500:350 100:250 1000:250 100:350 1000:350 500:250; do one 1 ${c%:*} ${c#*:} "A1 BE"; done
for c in 1000:350 500:250 100:350 1000:250 500:350 100:250; do one 2 ${c%:*} ${c#*:} "BE A1"; done
for c in 100:250 1000:350 500:350 100:350 500:250 1000:250; do one 3 ${c%:*} ${c#*:} "A1 BE"; done
echo "s-node active changes during the run (Lease 2s, busy): $(kubectl -n watchdog logs -l app=snode --timestamps --since-time=$start --tail=-1 2>/dev/null | grep -c 'is now the active s-node'), restarts: $(kubectl -n watchdog get pods --no-headers | awk '{printf "%s ", $4}')"
for i in $(seq 1 10); do docker start mt$i >/dev/null 2>&1; done
echo "ALL-DONE $(date +%H:%M)"
