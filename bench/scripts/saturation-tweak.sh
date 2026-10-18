#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# 상한 재측정: 워커 5, 목표 3000 TPS, smallbank, 긴급 0, 20초, A2·B 각 2회 (샘플러 없음)
# 사용: saturation-tweak.sh <태그>
cd $(cd "$HERE/../zipfbench" && pwd)
for rep in 1 2; do
  for sys in A2 B; do
    WORKERS=5 TPS=3000 DURATION=20 RUN_ID=saturation4/$1 SYSTEMS=$sys URGENT_LIST=0 REPS=$rep ./userbench.sh 2>&1 | grep -E '^\| users|실패|건너뜀' | sed "s/^/$1 rep$rep $sys /"
  done
done
echo ALL-DONE
