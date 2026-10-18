#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §48 본 측정: 새 설정 → 예전 설정 → 새 설정으로 되돌리고 10분 동안 잘못된 활성 전환이 있는지 본다.
set -u; export MSYS_NO_PATHCONV=1
R=${DATA_ROOT:-$HOME/fig57-data}/mttr-1017
cd "$(dirname "$0")"
OUT=$R/new CONFIG=new TRIALS=10 ./mttr.sh
OUT=$R/old CONFIG=old TRIALS=10 ./mttr.sh
# 새 설정으로 되돌린다 (s-node 환경 변수 제거, w-node 새 값으로 다시 띄움)
K="kubectl -n watchdog"
$K set env deploy/snode SNODE_LEASE_DURATION- SNODE_RENEW_DEADLINE- SNODE_RETRY_PERIOD- SNODE_EARLY_COMMITTEE- >/dev/null
$K rollout status deploy/snode --timeout=240s >/dev/null
( cd ../../w-node && IMAGE=watchdog/w-node:mttr-1017f NAME_PREFIX=mt ./run_local.sh 10 mychannel -padding 1000000 )
sleep 30
start=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "idle check from $start" > $R/idle.txt
sleep 600
end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "active changes (should be 0): $($K logs -l app=snode --timestamps --since-time=$start --tail=-1 2>/dev/null | grep -c 'is now the active s-node')" >> $R/idle.txt
echo "lease lost: $($K logs -l app=snode --timestamps --since-time=$start --tail=-1 2>/dev/null | grep -ci 'lost the lease\|leaderelection lost\|stopped leading')" >> $R/idle.txt
echo "pod restarts:" >> $R/idle.txt; $K get pods --no-headers >> $R/idle.txt
for i in $(seq 1 10); do echo "mt$i committee applies during idle: $(docker logs --since $start mt$i 2>&1 | grep -c '적용됨')"; done >> $R/idle.txt
echo "ALL-DONE $(date +%H:%M)" >> $R/idle.txt
