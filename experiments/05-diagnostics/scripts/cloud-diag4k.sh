#!/bin/bash
# §80 4,000 TPS 진단 (Fabric VM 에서): Fabric VM 의 무엇이 포화되는가. smallbank s 1.0, 배치 1000, 워커 30, 30초, BE·A1 1회씩.
# 실행 내내(네트워크 준비 포함) 컨테이너별 CPU 와 VM 전체 CPU 를 기록하고, 나중에 바쁜 구간만 고른다: /opt/work/diag-<sys>.txt
# (docker stats 흐름 모드는 timeout 으로 끝나지 않아 --no-stream 을 되풀이한다)
set -u
cd /opt/work
export MODE=smallbank WORKERS=30 TPS=4000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 ZIPF_S=1.0 BATCH_SIZE=1000 BATCH_TIMEOUT=10s
for sys in ${DIAG_SYS:-BE A1}; do
  echo "### $sys $(date +%H:%M:%S)"
  ( while true; do echo "T $(date +%s) $(top -b -n 1 | sed -n 3p)"; sudo docker stats --no-stream --format 'C {{.Name}} {{.CPUPerc}} {{.MemUsage}}'; done > /opt/work/diag-$sys.txt 2>&1 ) &
  mon=$!
  env RUN_ID=diag4k-$sys SYSTEMS=$sys bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'
  kill $mon 2>/dev/null; sleep 3; pkill -P $mon 2>/dev/null
done
echo "ALL-DONE $(date +%H:%M:%S)"
