#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# custom + 읽기 전용 50% (2026-10-16, NOTES §34): 읽기 전용 우선(Algorithm 1)이 custom 에서 작동하는지 본다.
# 나머지 조건은 main2-custom 과 같다 (RW 8 / HR 0.4 / HW 0.1 / HSS 1%, 배치 100, 30초, 250 TPS, 긴급 0/1 × 3회)
cd $(cd "$HERE/../zipfbench" && pwd)
F='^\[.*== |^\| users|실패|건너뜀'
MODE=custom RW=8 HR=0.4 HW=0.1 HOT_SHARE=0.01 QUERY_SHARE=0.5 RUN_ID=customq SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0 1" REPS=3 ./userbench.sh 2>&1 | grep -E "$F"
MODE=custom RW=8 HR=0.4 HW=0.1 HOT_SHARE=0.01 QUERY_SHARE=0.5 EPS_URGENT=1 EPS_LOW=1 RUN_ID=customq-eps11 SYSTEMS="BE" URGENT_LIST="0 1" REPS=3 ./userbench.sh 2>&1 | grep -E "$F"
echo ALL-DONE
