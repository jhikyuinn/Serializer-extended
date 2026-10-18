#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §43: 부하 격자를 다시 (Docker 재시작 뒤). §42 의 a2load-* 는 50→400 순서로 돌리는 동안 PC 가 느려져
# (같은 250 TPS 조건에서 지연 +0.15~0.4 s) 부하 효과와 섞였다. 순서를 섞고 250 TPS 를 각 바퀴 처음·끝에 둬 흔들림을 본다.
# 시스템: A1, A2, BE(ε .1/.75), BE(ε 1/1). s 1.15, 긴급 0. 바퀴마다 1회, 2바퀴. 결과: results/load2-t<t>, results/load2e11-t<t>
cd $(cd "$HERE/../zipfbench" && pwd)
unset PROCESSOR_ABORT_MODE PROCESSOR_ABORT_DELAY
F='^\[.*== |^\| users|실패|건너뜀'
drop() { MSYS_NO_PATHCONV=1 docker run --rm --privileged alpine sh -c 'sync; echo 1 > /proc/sys/vm/drop_caches' >/dev/null 2>&1; }
one() { # $1 바퀴, $2 TPS, $3 시스템 순서, $4 ε1/1 을 먼저(1) 또는 나중(0)
  local r=$1 t=$2
  [ "$4" = 1 ] && { echo "### load2e11-t$t r$r $(date +%H:%M)"; env RUN_ID=load2e11-t$t TPS=$t ZIPF_S=1.15 EPS_URGENT=1 EPS_LOW=1 SYSTEMS="BE" URGENT_LIST=0 REPS=1 REP_START=$r ./userbench.sh 2>&1 | grep -E "$F"; drop; }
  echo "### load2-t$t r$r $(date +%H:%M)"; env RUN_ID=load2-t$t TPS=$t ZIPF_S=1.15 SYSTEMS="$3" URGENT_LIST=0 REPS=1 REP_START=$r ./userbench.sh 2>&1 | grep -E "$F"; drop
  [ "$4" = 0 ] && { echo "### load2e11-t$t r$r $(date +%H:%M)"; env RUN_ID=load2e11-t$t TPS=$t ZIPF_S=1.15 EPS_URGENT=1 EPS_LOW=1 SYSTEMS="BE" URGENT_LIST=0 REPS=1 REP_START=$r ./userbench.sh 2>&1 | grep -E "$F"; drop; }
}
for tr in 250:1 100:1 400:1 50:1 300:1 150:1 350:1 200:1 250:3; do one ${tr#*:} ${tr%:*} "A1 A2 BE" 0; done
for tr in 250:2 200:2 350:2 150:2 300:2 50:2 400:2 100:2 250:4; do one ${tr#*:} ${tr%:*} "BE A2 A1" 1; done  # 250 은 바퀴 처음·끝을 rep 1·3, 2·4 로
echo "ALL-DONE $(date +%H:%M)"
