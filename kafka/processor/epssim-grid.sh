#!/bin/bash
# §74 ε 시뮬레이션 격자 (golang 컨테이너 안에서). 조건마다 따로, 한 조건 900 초 제한. 순서대로(정렬 시간을 재므로 병렬로 돌리지 않는다).
cd "$(dirname "$0")"
for u in 0 1; do for b in 5000 10000; do for s in 1.0 1.5 2.0; do
  reps=20; [ $b = 10000 ] && reps=12
  for e in "0 0" "0.25 0.25" "0.5 0.5" "0.1 0.75" "0.75 0.75" "1 1"; do
    set -- $e
    out=$(EPS_SIM=1 COST_URGENT=$u COST_S=$s COST_BATCH=$b COST_EPS_U=$1 COST_EPS_L=$2 COST_REPS=$reps timeout 900 ./epscost.test -test.run TestEpsSim 2>&1 | grep EPSSIM)
    [ -z "$out" ] && out="[EPSSIM-BATCH] urgent=$u s=$s batch=$b epsU=$1 epsL=$2 TIMEOUT"
    echo "$out"
  done
done; done; done
echo SIM-DONE
