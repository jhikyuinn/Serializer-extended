#!/bin/bash
# §48 측정 단계가 끝날 때마다, 그리고 시간 초과 시도가 생길 때마다 한 줄씩 낸다. 29분 뒤 스스로 끝난다.
R=${DATA_ROOT:-$HOME/fig57-data}/mttr-1017
S=$R/.watch-state; touch $S
start=$(date +%s)
while [ $(( $(date +%s) - start )) -lt 1740 ]; do
  for ph in new old; do
    if grep -q "끝" $R/$ph/run.log 2>/dev/null && ! grep -qx "done-$ph" $S; then
      echo "done-$ph" >> $S
      echo "단계 끝: $ph — $(awk -F, -v p=$ph 'NR>1 && $6!="" {n++; s+=$6} NR>1 && $6=="" {t++} END{printf "성공 %d회, 시간초과 %d회, 평균 MTTR %.1f s", n, t, (n? s/n/1000:0)}' $R/$ph/trials.csv)"
    fi
    for l in $(grep -n "mttr=timeout" $R/$ph/run.log 2>/dev/null | cut -d: -f1); do
      grep -qx "to-$ph-$l" $S || { echo "to-$ph-$l" >> $S; echo "문제: $ph 시도 시간 초과 — $(sed -n ${l}p $R/$ph/run.log)"; }
    done
  done
  if grep -q ALL-DONE $R/idle.txt 2>/dev/null && ! grep -qx done-idle $S; then
    echo done-idle >> $S; echo "단계 끝: idle — $(tr '\n' ' ' < $R/idle.txt | cut -c1-400)"; exit 0
  fi
  if ! ps -ef | grep -v grep | grep -q "run-all.sh" && ! grep -q ALL-DONE $R/idle.txt 2>/dev/null; then
    echo "문제: run-all.sh 가 끝 표시 없이 멈췄다"; exit 0
  fi
  sleep 15
done
