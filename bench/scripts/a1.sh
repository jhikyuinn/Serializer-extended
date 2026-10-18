#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §42: 논문 A-1(Fig 13) 재현을 넘어서 — 외부 정렬의 추가 지연과 이득. 논문 값이 맞다고 가정하지 않는다.
#  1단계: Zipf s 격자 0 0.5 0.8 1.0 1.15 1.3 1.5 2.0 × (A1 같은 소스 Fabric, A2 Fabric 2.5.10, BE ε .1/.75, BE ε 1/1), 250 TPS, 긴급 0, 3회
#  2단계: 부하 격자 50~400 TPS × 같은 시스템, s 1.15, 긴급 0, 2회
# A1 = 같은 소스에서 Kafka 경로만 뺀 Fabric → 외부 정렬 비용의 대조군. 결과: results/a1-*, results/a2load-*
cd $(cd "$HERE/../zipfbench" && pwd)
unset PROCESSOR_ABORT_MODE PROCESSOR_ABORT_DELAY
F='^\[.*== |^\| users|실패|건너뜀'
run() { echo "### $1 시작 $(date +%H:%M)"; env "${@:2}" ./userbench.sh 2>&1 | grep -E "$F" | sed "s/^/$1 /"; }
for s in 0 0.5 0.8 1.0 1.15 1.3 1.5 2.0; do
  run a1-s$s      RUN_ID=a1-s$s      ZIPF_S=$s SYSTEMS="A1 A2 BE" URGENT_LIST=0 REPS=3
  run a1e11-s$s   RUN_ID=a1e11-s$s   ZIPF_S=$s EPS_URGENT=1 EPS_LOW=1 SYSTEMS="BE" URGENT_LIST=0 REPS=3
done
for t in 50 100 150 200 250 300 350 400; do
  run a2load-t$t     RUN_ID=a2load-t$t     TPS=$t ZIPF_S=1.15 SYSTEMS="A1 A2 BE" URGENT_LIST=0 REPS=2
  run a2loade11-t$t  RUN_ID=a2loade11-t$t  TPS=$t ZIPF_S=1.15 EPS_URGENT=1 EPS_LOW=1 SYSTEMS="BE" URGENT_LIST=0 REPS=2
done
echo "ALL-DONE $(date +%H:%M)"
