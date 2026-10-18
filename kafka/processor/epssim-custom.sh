#!/bin/bash
# §75 ε 시뮬레이션 custom 부하 격자 (golang 컨테이너 안에서). 혼잡은 인기 키 확률(hr/hw). 조건마다 900 초 제한, 차례로.
cd "$(dirname "$0")"
for u in 0 1; do for b in 1000 5000 10000; do for h in "0.2 0.1" "0.4 0.2" "0.6 0.3"; do
  set -- $h; hr=$1; hw=$2
  reps=20; [ $b = 10000 ] && reps=12
  for e in "0 0" "0.25 0.25" "0.5 0.5" "0.1 0.75" "0.75 0.75" "1 1"; do
    set -- $e
    out=$(EPS_SIM=1 COST_MODE=custom COST_URGENT=$u COST_HR=$hr COST_HW=$hw COST_BATCH=$b COST_EPS_U=$1 COST_EPS_L=$2 COST_REPS=$reps timeout 900 ./epscost.test -test.run TestEpsSim 2>&1 | grep EPSSIM)
    [ -z "$out" ] && out="[EPSSIM-BATCH] mode=custom urgent=$u hr=$hr hw=$hw qs=0.00 batch=$b epsU=$1 epsL=$2 TIMEOUT"
    echo "$out"
  done
done; done; done
echo SIM-DONE
