#!/bin/bash
# §67 오더러 계측 실행 (Fabric VM 에서): Serializer(BE)가 1,000 TPS 를 다 받지 못하는 원인 찾기.
# 계측 오더러(serializer/fabric-orderer:prof 를 :latest 로 태그)로 §54 와 같은 조건을 1회씩 돈다.
#   s 0 / 1.0 / 2.0 × 배치 100, s 1.0 × 배치 1000  (BE 만, 1,000 TPS, 30초, 앞 5초 제외)
# 결과: results/prof-s<s>-b<B>/BE/u0/rep1/orderer.log 의 [ORDSTAT]·[ORDBATCH] → bench-scripts/ordstat.js
set -u
cd /opt/work
export TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 SYSTEMS=BE
F='^\[.*== |^\| users|실패|건너뜀|재사용'
one() { # batch timeout s
  echo "### b$1 s$3 $(date +%H:%M:%S)"
  env RUN_ID=prof-s$3-b$1 BATCH_SIZE=$1 BATCH_TIMEOUT=$2 ZIPF_S=$3 bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
}
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
one 100 2s 1.0
one 100 2s 2.0
one 100 2s 0
one 1000 10s 1.0
echo "ALL-DONE $(date +%H:%M:%S)"
