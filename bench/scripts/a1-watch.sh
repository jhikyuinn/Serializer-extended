#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# a1.sh 진행 감시: 문제(요약 없음, 전송률 낮음, 성공률 이상, 실패 로그, 8분 정체, 비정상 종료)만 한 줄씩 낸다.
R=$(cd "$HERE/../zipfbench" && pwd)/results
SEEN=$R/.a1-watch-seen; touch $SEEN
OUTN=$R/.a1-watch-outlines; [ -f $OUTN ] || echo 0 > $OUTN
lastprog=$(date +%s); stalled=0
while true; do
  for m in $(ls $R/a1-s*/*/*/*/meta.json $R/a1e11-s*/*/*/*/meta.json $R/a2load*/*/*/*/meta.json 2>/dev/null); do
    grep -qxF "$m" $SEEN && continue
    echo "$m" >> $SEEN; lastprog=$(date +%s); stalled=0
    d=$(dirname $m); name=${d#$R/}
    line=$(grep -m1 '^| users' $d/caliper.log 2>/dev/null)
    if [ -z "$line" ]; then echo "문제: $name 에 Caliper 요약이 없다"; continue; fi
    tps=$(grep -o '"tps":[0-9.]*' $m | cut -d: -f2)
    set -- $(echo "$line" | awk -F'|' '{gsub(/ /,""); print $3, $4, $5}')
    succ=$1; fail=$2; send=$3
    awk -v s="$send" -v t="$tps" 'BEGIN{exit !(s < 0.85*t)}' && echo "문제: $name 전송률 $send TPS (목표 $tps)"
    awk -v a="$succ" -v b="$fail" 'BEGIN{exit !(a+b>0 && a/(a+b) < 0.05)}' && echo "문제: $name 성공률이 5% 미만 ($succ / $((succ+fail)))"
  done
  n=$(wc -l < $R/a1.out); o=$(cat $OUTN)
  if [ "$n" -gt "$o" ]; then
    tail -n +$((o+1)) $R/a1.out | grep -E '실패|건너뜀|0 이 아닌|못했다|error|Error' | sed 's/^/문제(로그): /'
    echo $n > $OUTN
  fi
  if [ $(( $(date +%s) - lastprog )) -gt 480 ] && [ $stalled = 0 ]; then echo "문제: 8분 넘게 새 결과가 없다 (마지막 진행 $(date -d @$lastprog +%H:%M))"; stalled=1; fi
  if ! ps -ef | grep -v grep | grep -q "bench-scripts/a1.sh"; then
    if grep -q ALL-DONE $R/a1.out; then echo "끝: $(grep ALL-DONE $R/a1.out)"; else echo "문제: a1.sh 가 ALL-DONE 없이 끝났다"; fi
    exit 0
  fi
  sleep 20
done
