#!/bin/bash
# §55 저충돌 구간: 계좌 1,000 / 10,000 × s 0/0.5/1.0 × 배치 100/1000 × (A1, BE), 1000 TPS, 30초(앞 5초 제외), 긴급 0, 3바퀴.
# 묶음 = (시스템, 배치, 계좌 수). 묶음 안에서 s 를 섞어 이어 돌린다(REUSE_NETWORK). 결과: results/cloud-a<A>-s<s>-b<B>
set -u
cd /opt/work
export TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1
F='^\[.*== |^\| users|실패|건너뜀|재사용'
to() { case $1 in 100) echo 2s;; 1000) echo 10s;; esac; }
one() { # rep sys batch acct s
  echo "### r$1 $2 b$3 a$4 s$5 $(date +%H:%M:%S)"
  env RUN_ID=cloud-a$4-s$5-b$3 SYSTEMS=$2 BATCH_SIZE=$3 BATCH_TIMEOUT=$(to $3) ACCOUNT_COUNT=$4 ZIPF_S=$5 REP_START=$1 \
    bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
}
group() { for s in $5; do one $1 $2 $3 $4 $s; done; }
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
group 1 A1 100 1000 "0.5 0 1.0";   group 1 BE 1000 10000 "1.0 0.5 0"; group 1 BE 100 1000 "0 1.0 0.5"; group 1 A1 1000 10000 "0 0.5 1.0"
group 1 BE 1000 1000 "0.5 1.0 0";  group 1 A1 100 10000 "1.0 0 0.5";  group 1 A1 1000 1000 "0 1.0 0.5"; group 1 BE 100 10000 "0.5 0 1.0"
group 2 BE 100 10000 "1.0 0.5 0";  group 2 A1 1000 1000 "0.5 0 1.0";  group 2 BE 100 1000 "1.0 0 0.5"; group 2 A1 100 10000 "0 1.0 0.5"
group 2 A1 1000 10000 "1.0 0.5 0"; group 2 BE 1000 1000 "0 0.5 1.0";  group 2 A1 100 1000 "1.0 0.5 0"; group 2 BE 1000 10000 "0.5 1.0 0"
group 3 A1 1000 1000 "1.0 0.5 0";  group 3 BE 100 10000 "0 1.0 0.5";  group 3 BE 1000 1000 "1.0 0 0.5"; group 3 A1 100 1000 "0 0.5 1.0"
group 3 BE 1000 10000 "0 1.0 0.5"; group 3 A1 1000 10000 "0.5 0 1.0"; group 3 BE 100 1000 "0.5 1.0 0"; group 3 A1 100 10000 "0.5 0 1.0"
. /opt/work/cloud-run.env; cd HLF/fabric-samples/zipfbench
rm -f results/.net-signature; SYSTEM=A2 network/network.sh down >/dev/null 2>&1
(cd "$KAFKA_DIR" && PROCESSOR_ALGO=serializer DOCKER_HOST="$KAFKA_DOCKER_HOST" docker compose -f docker-compose.yml -f docker-compose.processor.yml up -d --no-build --force-recreate processor >/dev/null 2>&1)
echo "ALL-DONE $(date +%H:%M:%S)"
