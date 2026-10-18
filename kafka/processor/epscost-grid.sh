#!/bin/bash
# §73 ε 정렬 비용 격자 (golang 컨테이너 안에서): ./epscost.test 를 조건마다 따로 돌린다. 한 조건 120 초 넘으면 끊고 같은 (긴급, s, ε) 의 더 큰 배치는 건너뛴다.
cd "$(dirname "$0")"
for u in 0 1; do for s in 1.0 2.0; do
  for e in "0 0" "0.1 0.75" "0.25 0.25" "0.5 0.5" "0.75 0.75" "1 1"; do
    set -- $e; skip=0
    for b in 1000 2500 5000 10000; do
      if [ $skip = 1 ]; then echo "[EPSCOST] urgent=$([ $u = 1 ] && echo true || echo false) s=$s batch=$b epsU=$1 epsL=$2 SKIPPED"; continue; fi
      reps=5; [ $b = 10000 ] && reps=3
      out=$(EPS_COST=1 COST_URGENT=$u COST_S=$s COST_BATCH=$b COST_EPS_U=$1 COST_EPS_L=$2 COST_REPS=$reps timeout 120 ./epscost.test -test.run TestEpsCost 2>&1 | grep EPSCOST)
      if [ -z "$out" ]; then echo "[EPSCOST] urgent=$([ $u = 1 ] && echo true || echo false) s=$s batch=$b epsU=$1 epsL=$2 TIMEOUT>120s"; skip=1; else echo "$out"; fi
    done
  done
done; done
echo GRID-DONE
