#!/bin/bash
# §68 Caliper 워커 CPU 비교 (Fabric VM 에서): s 2.0 × 배치 100, 1,000 TPS, 30초.
#   A1 / BE / BE(abort 통보 끔) 를 돌리며 Client VM 의 node 프로세스 CPU 를 2초마다 기록한다.
set -u
cd /opt/work
. /opt/work/cloud-run.env
CL=${CALIPER_DOCKER_HOST#ssh://}
export TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 BATCH_SIZE=100 BATCH_TIMEOUT=2s ZIPF_S=2.0
run() { # 이름 시스템 통보
  echo "### $1 $(date +%H:%M:%S)"
  ssh -o StrictHostKeyChecking=no $CL 'for i in $(seq 60); do date +%s; top -b -n 1 -o %CPU | grep " node" | head -12; sleep 2; done' > /opt/work/cpu-$1.txt 2>&1 &
  local mon=$!
  env RUN_ID=cpuchk-$1 SYSTEMS=$2 ABORT_NOTIFY=$3 bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'
  kill $mon 2>/dev/null; wait $mon 2>/dev/null
}
run be BE true
run be-nonotify BE false
run a1 A1 true
echo "ALL-DONE $(date +%H:%M:%S)"
