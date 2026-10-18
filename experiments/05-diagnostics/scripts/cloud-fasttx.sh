#!/bin/bash
# §68 SDK 리스너 우회(users.js installFastTxListener) 확인 (Fabric VM 에서): s 2.0 × 배치 100, 1,000 TPS, 30초, BE·A1.
set -u
cd /opt/work
export TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 BATCH_SIZE=100 BATCH_TIMEOUT=2s ZIPF_S=2.0 CALIPER_CPU_PROF=1
for sys in BE A1; do
  echo "### $sys $(date +%H:%M:%S)"
  env RUN_ID=fasttx-$sys SYSTEMS=$sys bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'
done
echo "ALL-DONE $(date +%H:%M:%S)"
