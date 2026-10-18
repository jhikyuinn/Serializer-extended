#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# 포화 실험 + Windows 쪽 CPU: 워커 5·20 × A2·B, 목표 3000 TPS, smallbank, 긴급 0, 20초
cd $(cd "$HERE/../zipfbench" && pwd)
OUT=results/saturation3
mkdir -p $OUT
rm -f $OUT/.done
( until [ -f $OUT/.done ]; do echo "T $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> $OUT/docker-stats.log; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' >> $OUT/docker-stats.log 2>/dev/null; sleep 3; done ) &
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$HERE/win-cpu-sampler.ps1")" "$(cygpath -w $PWD/$OUT/win-cpu.log)" "$(cygpath -w $PWD/$OUT/.done)" &
for w in 5 20; do
  for sys in A2 B; do
    WORKERS=$w TPS=3000 DURATION=20 RUN_ID=saturation3/w$w SYSTEMS=$sys URGENT_LIST=0 REPS=1 ./userbench.sh 2>&1 | grep -E '^\| users|실패|건너뜀' | sed "s/^/workers=$w $sys /"
  done
done
touch $OUT/.done
wait
echo ALL-DONE
