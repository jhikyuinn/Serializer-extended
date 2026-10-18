#!/bin/bash
# §54 클라우드 본 실험 (Fabric VM 에서): s 0/0.5/1.0/1.5/2.0 × 배치 100/500/1000 × (A1, BE ε .1/.75), 1000 TPS,
# 30초(앞 5초 제외 집계도 남김), 긴급 0, 3바퀴. 같은 (시스템, 배치) 묶음 안에서는 네트워크를 다시 쓴다(REUSE_NETWORK).
# 바퀴마다 묶음 순서를 섞고, 묶음 안에서도 s 순서를 섞는다. 결과: results/cloud-s<s>-b<B>
set -u
cd /opt/work
export TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1
F='^\[.*== |^\| users|실패|건너뜀|재사용'
to() { case $1 in 100) echo 2s;; 500) echo 5s;; 1000) echo 10s;; esac; }
one() { # rep sys batch s
  echo "### r$1 $2 b$3 s$4 $(date +%H:%M:%S)"
  env RUN_ID=cloud-s$4-b$3 SYSTEMS=$2 BATCH_SIZE=$3 BATCH_TIMEOUT=$(to $3) ZIPF_S=$4 REP_START=$1 \
    bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
}
group() { # rep sys batch "s 순서"
  for s in $4; do one $1 $2 $3 $s; done
}
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
# 1바퀴
group 1 A1 500 "1.0 0 2.0 0.5 1.5";  group 1 BE 100 "0.5 2.0 0 1.5 1.0";  group 1 A1 1000 "1.5 0.5 1.0 2.0 0"
group 1 BE 500 "2.0 1.0 0.5 0 1.5";  group 1 A1 100 "0 1.5 0.5 1.0 2.0";  group 1 BE 1000 "1.0 2.0 1.5 0 0.5"
# 2바퀴
group 2 BE 1000 "0 0.5 2.0 1.0 1.5"; group 2 A1 100 "2.0 1.0 0 0.5 1.5";  group 2 BE 500 "1.5 0 1.0 2.0 0.5"
group 2 A1 1000 "0.5 1.0 0 1.5 2.0"; group 2 BE 100 "1.0 1.5 2.0 0.5 0";  group 2 A1 500 "2.0 0.5 1.5 0 1.0"
# 3바퀴
group 3 A1 100 "1.5 2.0 1.0 0 0.5";  group 3 BE 500 "0.5 1.5 0 1.0 2.0";  group 3 A1 500 "0 2.0 1.5 0.5 1.0"
group 3 BE 100 "2.0 0 1.0 1.5 0.5";  group 3 A1 1000 "1.0 0 0.5 2.0 1.5"; group 3 BE 1000 "1.5 1.0 2.0 0.5 0"
# 끝: 네트워크를 내리고 프로세서를 되돌린다
. /opt/work/cloud-run.env; cd HLF/fabric-samples/zipfbench
rm -f results/.net-signature; SYSTEM=A2 network/network.sh down >/dev/null 2>&1
(cd "$KAFKA_DIR" && PROCESSOR_ALGO=serializer DOCKER_HOST="$KAFKA_DOCKER_HOST" docker compose -f docker-compose.yml -f docker-compose.processor.yml up -d --no-build --force-recreate processor >/dev/null 2>&1)
echo "ALL-DONE $(date +%H:%M:%S)"
