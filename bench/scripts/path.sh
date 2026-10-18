#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
# 커밋 경로 분해 (2026-10-16, NOTES §37): 오더러 로그를 함께 남겨 commit→블록 구간을 나눈다. smallbank, 긴급 0, 2회
cd $(cd "$HERE/../zipfbench" && pwd)
RUN_ID=path-smallbank SYSTEMS="A2 FPP HTF BE" URGENT_LIST="0" REPS=2 ./userbench.sh 2>&1 | grep -E '^\[.*== |^\| users|실패|건너뜀'
echo ALL-DONE
