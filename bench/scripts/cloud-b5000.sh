#!/bin/bash
# §71 4,000 TPS × 배치 5000 간이 비교 (Fabric VM 에서): BE·A1, s 1.0, 30초(앞 5초 제외), 1회, 워커 30. CPU 기록은 cloud-hightps.sh 와 같다.
set -u
cd /opt/work
. /opt/work/cloud-run.env
CL=${CALIPER_DOCKER_HOST#ssh://}
export DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 ZIPF_S=1.0 WORKERS=30 TPS=4000 BATCH_SIZE=5000 BATCH_TIMEOUT=10s
for sys in BE A1; do
  r=b5000-$sys
  echo "### $r $(date +%H:%M:%S)"
  ssh -o StrictHostKeyChecking=no $CL 'for i in $(seq 70); do echo "$(date +%s) $(top -b -n 1 | sed -n 3p)"; sleep 2; done' > /opt/work/cpu-$r.txt 2>&1 &
  mon=$!
  ( for i in $(seq 70); do echo "$(date +%s) $(top -b -n 1 | sed -n 3p)"; sleep 2; done ) > /opt/work/cpuf-$r.txt 2>&1 &
  monf=$!
  env RUN_ID=$r SYSTEMS=$sys bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|건너뜀|재사용'
  kill $mon $monf 2>/dev/null; wait $mon $monf 2>/dev/null
done
echo "ALL-DONE $(date +%H:%M:%S)"
