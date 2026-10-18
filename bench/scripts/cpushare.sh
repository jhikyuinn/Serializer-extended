#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §51: 400 TPS 에서 CPU 를 누가 쓰는지 (A1, BE 각 1회, 60초). docker stats 3초, Windows CPU 2초.
cd $(cd "$HERE/../zipfbench" && pwd)
OUT=results/cpushare; mkdir -p $OUT; rm -f $OUT/.done $OUT/docker-stats.log $OUT/win-cpu.log
( until [ -f $OUT/.done ]; do echo "T $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> $OUT/docker-stats.log; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' >> $OUT/docker-stats.log 2>/dev/null; sleep 3; done ) &
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$HERE/win-cpu-sampler.ps1")" "$(cygpath -w $PWD/$OUT/win-cpu.log)" "$(cygpath -w $PWD/$OUT/.done)" &
for sys in A1 BE; do
  TPS=400 DURATION=60 RUN_ID=cpushare SYSTEMS=$sys URGENT_LIST=0 REPS=1 ./userbench.sh 2>&1 | grep -E '^\| users|실패|건너뜀' | sed "s/^/$sys /"
done
touch $OUT/.done; wait; echo ALL-DONE
