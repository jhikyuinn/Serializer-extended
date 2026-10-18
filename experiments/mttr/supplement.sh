#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §48 보충: 빠진 SIGSTOP 시도 (새 설정 3회, 예전 설정 5회). 끝나면 새 설정으로 되돌린다.
set -u; export MSYS_NO_PATHCONV=1
R=${DATA_ROOT:-$HOME/fig57-data}/mttr-1017
cd "$(dirname "$0")"
OUT=$R/new-stop CONFIG=new TYPES=stop TRIALS=3 ./mttr.sh
OUT=$R/old-stop CONFIG=old TYPES=stop TRIALS=5 ./mttr.sh
K="kubectl -n watchdog"
$K set env deploy/snode SNODE_LEASE_DURATION- SNODE_RENEW_DEADLINE- SNODE_RETRY_PERIOD- SNODE_EARLY_COMMITTEE- >/dev/null
$K rollout status deploy/snode --timeout=240s >/dev/null
( cd ../../w-node && IMAGE=watchdog/w-node:mttr-1017f NAME_PREFIX=mt ./run_local.sh 10 mychannel -padding 1000000 )
echo "ALL-DONE $(date +%H:%M)" > $R/supplement.done
