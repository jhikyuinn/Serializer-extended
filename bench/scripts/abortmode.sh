#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# §38: abort 기록 보내는 방식이 commit→오더러 구간을 늦추는지 (Serializer, smallbank, 긴급 0, 2회씩)
cd $(cd "$HERE/../zipfbench" && pwd)
F='^\[.*== |^\| users|실패|건너뜀'
for mode in inline separate delayed; do
  export PROCESSOR_ABORT_MODE=$mode PROCESSOR_ABORT_DELAY=100ms
  RUN_ID=abortmode-$mode SYSTEMS="BE" URGENT_LIST="0" REPS=2 ./userbench.sh 2>&1 | grep -E "$F" | sed "s/^/$mode /"
  docker logs kafka-processor-1 2>&1 | grep -m1 "abort mode" | sed "s/^/$mode check: /"
done
unset PROCESSOR_ABORT_MODE PROCESSOR_ABORT_DELAY
echo ALL-DONE
