#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# 클라이언트(Caliper 워커)를 늘려 이 PC 의 상한을 본다. smallbank, 긴급 0, 배치 100, 20초, 목표 3000 TPS
cd $(cd "$HERE/../zipfbench" && pwd)
OUT=results/saturation2
mkdir -p $OUT
# 컨테이너 CPU 를 3초마다 기록 (끝나면 멈춘다)
( until [ -f $OUT/.done ]; do echo "T $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> $OUT/docker-stats.log; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' >> $OUT/docker-stats.log 2>/dev/null; sleep 3; done ) &
for w in 10 20 30; do
  for sys in A2 B; do
    WORKERS=$w TPS=3000 DURATION=20 RUN_ID=saturation2/w$w SYSTEMS=$sys URGENT_LIST=0 REPS=1 ./userbench.sh 2>&1 | grep -E '^\| users|실패|건너뜀' | sed "s/^/workers=$w $sys /"
  done
done
touch $OUT/.done
wait
echo ALL-DONE
