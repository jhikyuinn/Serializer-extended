#!/bin/bash
# §69 Serializer 고부하 간이 확인 (Fabric VM 에서): BE, s 1.0, TPS 2000/3000/4000/5000 × 배치 100/1000, 30초(앞 5초 제외), 1회.
# Caliper 워커 HT_WORKERS(기본 30, 사용자 5명 × 6). Client VM·Fabric VM 전체 CPU 를 2초마다 기록한다(cpu-<RUN>.txt, cpuf-<RUN>.txt). 오더러는 계측 이미지(§67).
set -u
cd /opt/work
. /opt/work/cloud-run.env
CL=${CALIPER_DOCKER_HOST#ssh://}
export DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 SYSTEMS=BE ZIPF_S=1.0 WORKERS=${HT_WORKERS:-30}
F='^\| users|실패|건너뜀|재사용'
for b in 100 1000; do
  to=2s; [ $b = 1000 ] && to=10s
  for t in 2000 3000 4000 5000; do
    r=${PREFIX:-ht30}-t$t-b$b
    echo "### $r $(date +%H:%M:%S)"
    ssh -o StrictHostKeyChecking=no $CL 'for i in $(seq 70); do echo "$(date +%s) $(top -b -n 1 | sed -n 3p)"; sleep 2; done' > /opt/work/cpu-$r.txt 2>&1 &
    mon=$!
    ( for i in $(seq 70); do echo "$(date +%s) $(top -b -n 1 | sed -n 3p)"; sleep 2; done ) > /opt/work/cpuf-$r.txt 2>&1 &
    monf=$!
    env RUN_ID=$r TPS=$t BATCH_SIZE=$b BATCH_TIMEOUT=$to bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
    kill $mon $monf 2>/dev/null; wait $mon $monf 2>/dev/null
  done
done
echo "ALL-DONE $(date +%H:%M:%S)"
