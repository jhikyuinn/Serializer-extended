#!/bin/bash
# §68 클라이언트 쪽 원인 확인 (Fabric VM 에서): abort 된 tx 의 SDK 커밋 대기(CALIPER_TIMEOUT)가 워커를 느리게 하는가.
# s 2.0 × 배치 100, BE, 1,000 TPS, 30초. CALIPER_TIMEOUT 30 과 3 을 비교하고, 그동안 Client VM 의 프로세스 CPU 를 잰다.
set -u
cd /opt/work
. /opt/work/cloud-run.env
CL=${CALIPER_DOCKER_HOST#ssh://}
export TPS=1000 DURATION=30 WARMUP_SEC=5 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 SYSTEMS=BE BATCH_SIZE=100 BATCH_TIMEOUT=2s ZIPF_S=2.0
for to in 30 3; do
  echo "### timeout $to $(date +%H:%M:%S)"
  ( sleep 45; ssh -o StrictHostKeyChecking=no $CL 'top -b -n 3 -d 5 -o %CPU | grep -E "node|PID" | head -30' > /opt/work/top-to$to.txt 2>&1 ) &
  env RUN_ID=tochk-to$to CALIPER_TIMEOUT=$to bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'
  wait
done
echo "ALL-DONE $(date +%H:%M:%S)"
