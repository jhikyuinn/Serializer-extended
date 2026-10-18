#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §39: abort 기록을 별도 producer 로 보내는 것(separate)을 기본으로 바꾼 뒤 주 실험을 모두 다시 돌린다.
# 조건은 예전 실행과 같다(배치 100, 30초, 250 TPS). 기존 결과는 그대로 두고 이름에 3 을 붙인다.
cd $(cd "$HERE/../zipfbench" && pwd)
unset PROCESSOR_ABORT_MODE PROCESSOR_ABORT_DELAY
F='^\[.*== |^\| users|실패|건너뜀'
C="MODE=custom RW=8 HR=0.4 HW=0.1 HOT_SHARE=0.01"
run() { echo "### $1 시작 $(date +%H:%M)"; env "${@:2}" ./userbench.sh 2>&1 | grep -E "$F" | sed "s/^/$1 /"; }
run path3-smallbank      RUN_ID=path3-smallbank SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0" REPS=2
docker inspect -f 'processor args: {{.Args}}' kafka-processor-1
run main3-smallbank      RUN_ID=main3-smallbank SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0 1" REPS=3
run main3-custom         $C RUN_ID=main3-custom SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0 1" REPS=3
run main3-custom-eps11   $C EPS_URGENT=1 EPS_LOW=1 RUN_ID=main3-custom-eps11 SYSTEMS="BE" URGENT_LIST="0 1" REPS=3
run customq3             $C QUERY_SHARE=0.5 RUN_ID=customq3 SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0 1" REPS=3
run customq3-eps11       $C QUERY_SHARE=0.5 EPS_URGENT=1 EPS_LOW=1 RUN_ID=customq3-eps11 SYSTEMS="BE" URGENT_LIST="0 1" REPS=3
echo "ALL-DONE $(date +%H:%M)"
