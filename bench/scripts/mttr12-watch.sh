#!/bin/bash
# §49 단계(g1, l1, g1l1, idle, busy)가 끝날 때마다, 시간 초과·준비 실패가 생길 때마다 한 줄. 29분 뒤 스스로 끝난다.
R=${DATA_ROOT:-$HOME/fig57-data}/mttr-1017b; S=$R/.watch; touch $S; start=$(date +%s)
while [ $(( $(date +%s) - start )) -lt 1740 ]; do
  for ph in g1 l1 g1l1; do
    if grep -q "끝" $R/$ph/run.log 2>/dev/null && ! grep -qx "d-$ph" $S; then echo "d-$ph" >> $S
      echo "단계 끝: $ph — $(awk -F, 'NR>1{k=$2; if($6==""){t[k]++} else {v[k]=v[k]" "sprintf("%.1f",$6/1000)}} END{for(k in v) printf "%s[%s] 시간초과 %d / ", k, v[k], t[k]+0}' $R/$ph/trials.csv)"; fi
    for l in $(grep -n "mttr=timeout\|준비되지 않았다" $R/$ph/run.log 2>/dev/null | cut -d: -f1); do
      grep -qx "p-$ph-$l" $S || { echo "p-$ph-$l" >> $S; echo "문제: $ph — $(sed -n ${l}p $R/$ph/run.log)"; }; done
  done
  for k in IDLE-DONE "busy 10min" ALL-DONE; do
    if grep -q "$k" $R/phase.txt 2>/dev/null && ! grep -qx "d-$k" $S; then echo "d-$k" >> $S; echo "단계 끝: $(grep "$k\|idle 10min" $R/phase.txt | tr '\n' ' ')"; fi
  done
  grep -q ALL-DONE $R/phase.txt 2>/dev/null && exit 0
  ps -ef | grep -v grep | grep -q run-12.sh || { echo "문제: run-12.sh 가 끝 표시 없이 멈췄다"; exit 0; }
  sleep 15
done
