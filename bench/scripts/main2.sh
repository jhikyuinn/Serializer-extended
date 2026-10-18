#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# 주 실험 다시 (2026-10-16): Serializer = 논문 알고리즘(BE, ε 0.1/0.75). 새 경로(§26), abort 통보, 배치 100, 30초, 250 TPS
# smallbank(주) + custom(보조, RW 8 / HR 0.4 / HW 0.1 / HSS 1%), A2 FPP HTF BE × 긴급 0/1 × 3회
cd $(cd "$HERE/../zipfbench" && pwd)
RUN_ID=main2-smallbank SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0 1" REPS=3 ./userbench.sh 2>&1 | grep -E '^\[.*== |^\| users|실패|건너뜀' | sed 's/^/smallbank /'
MODE=custom RW=8 HR=0.4 HW=0.1 HOT_SHARE=0.01 RUN_ID=main2-custom SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0 1" REPS=3 ./userbench.sh 2>&1 | grep -E '^\[.*== |^\| users|실패|건너뜀' | sed 's/^/custom /'
echo ALL-DONE
