#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §49: ① 유예 1초, ② Lease 1초, ①+② 의 MTTR (장애 유형마다 10회). 그다음 ①+② 로 잘못된 전환 점검:
# 장애 없이 10분, PC 가 바쁠 때(벤치마크 동시 실행) 10분. 끝나면 §48 기본값으로 되돌린다.
set -u; export MSYS_NO_PATHCONV=1
R=${DATA_ROOT:-$HOME/fig57-data}/mttr-1017b; mkdir -p $R
cd "$(dirname "$0")"
drop() { docker run --rm --privileged alpine sh -c 'sync; echo 1 > /proc/sys/vm/drop_caches' >/dev/null 2>&1; }
L1="SNODE_LEASE_DURATION=1s SNODE_RENEW_DEADLINE=750ms SNODE_RETRY_PERIOD=250ms"
drop; OUT=$R/g1   CONFIG=g1   SNODE_ENV="SNODE_EARLY_GRACE=1s" TRIALS=10 ./mttr.sh
drop; OUT=$R/l1   CONFIG=l1   SNODE_ENV="$L1" TRIALS=10 ./mttr.sh
drop; OUT=$R/g1l1 CONFIG=g1l1 SNODE_ENV="SNODE_EARLY_GRACE=1s $L1" TRIALS=10 ./mttr.sh
echo "MTTR-DONE $(date +%H:%M)" > $R/phase.txt
K="kubectl -n watchdog"
count() { $K logs -l app=snode --timestamps --since-time=$1 --tail=-1 2>/dev/null | grep -c 'is now the active s-node'; }
# 잘못된 전환 점검 ①: 장애 없이 10분 (w-node 는 떠 있다)
s=$(date -u +%Y-%m-%dT%H:%M:%SZ); sleep 600
echo "idle 10min ($s): active changes=$(count $s), restarts: $($K get pods --no-headers | awk '{printf "%s ", $4}')" >> $R/phase.txt
echo "IDLE-DONE $(date +%H:%M)" >> $R/phase.txt
# 잘못된 전환 점검 ②: 바쁠 때. w-node 는 멈추고(메모리), Fabric 벤치마크를 10분 돌린다 (Serializer, 350 TPS)
for i in $(seq 1 10); do docker stop mt$i >/dev/null 2>&1; done
drop
s=$(date -u +%Y-%m-%dT%H:%M:%SZ)
( cd $(cd "$HERE/../../bench/zipfbench" && pwd) && RUN_ID=lease-busy SYSTEMS=BE URGENT_LIST=0 REPS=1 TPS=350 DURATION=600 ./userbench.sh > $R/busy-bench.log 2>&1 )
echo "busy 10min ($s): active changes=$(count $s), restarts: $($K get pods --no-headers | awk '{printf "%s ", $4}')" >> $R/phase.txt
# 되돌리기: §48 기본값 (Lease 2s, 유예 3s), w-node 다시 시작
$K set env deploy/snode SNODE_LEASE_DURATION- SNODE_RENEW_DEADLINE- SNODE_RETRY_PERIOD- SNODE_EARLY_COMMITTEE- SNODE_EARLY_GRACE- >/dev/null
$K rollout status deploy/snode --timeout=240s >/dev/null
for i in $(seq 1 10); do docker start mt$i >/dev/null 2>&1; done
echo "ALL-DONE $(date +%H:%M)" >> $R/phase.txt
