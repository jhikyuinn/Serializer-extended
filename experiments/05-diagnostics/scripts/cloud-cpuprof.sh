#!/bin/bash
# §68 Caliper 워커 CPU 프로파일 (Fabric VM 에서): s 2.0 × 배치 100, 1,000 TPS, 30초, BE 와 A1.
# 결과: results/cpuprof-<sys>/.../prof/*.cpuprofile
set -u
cd /opt/work
export TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 BATCH_SIZE=100 BATCH_TIMEOUT=2s ZIPF_S=2.0
export CALIPER_CPU_PROF=1
for sys in BE A1; do
  echo "### $sys $(date +%H:%M:%S)"
  env RUN_ID=cpuprof-$sys SYSTEMS=$sys bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'
done
echo "ALL-DONE $(date +%H:%M:%S)"
