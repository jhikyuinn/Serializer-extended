#!/bin/bash
# §84 실험 4: 사용자 공정성 + 재정렬 알고리즘 비교 (Fabric VM 에서)
#   시스템: A1(Fabric), FPP(Fabric++), HTF(HTFabric WARD), BE ε(긴급 1, 일반 0.5 / 0.75 = 논문 / 1)
#   부하: smallbank(계좌 100, s 1.0) / custom(인기 키 0.2/0.1), 긴급 0 / 1(User3 의 쓰기, A1 은 0 만)
#   1,000 TPS, 배치 100, 워커 5, 30초(앞 5초 제외), 3바퀴. 바퀴마다 시스템 순서를 바꾼다.
#   네트워크는 시스템(알고리즘·ε)이 바뀔 때만 새로 띄운다: 시스템 하나에 부하 2 × 긴급 2 를 몰아서 돈다.
#   α 묶음: BE 논문 설정(1/0.75)에서 α 0 / 3 (α 1 은 본 묶음과 같다) × 부하 2 × 긴급 0 × 3바퀴.
# 결과: results/fair-<부하>-<라벨>/<SYS>/u<긴급>/rep<n>, results/fair-<부하>-BE075-a<α>/...
set -u
cd /opt/work
export WORKERS=5 TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 REPS=1 REUSE_NETWORK=1 ZIPF_S=1.0 BATCH_SIZE=100 BATCH_TIMEOUT=2s EPS_URGENT=1
F='^\| users|실패|건너뜀|재사용'
one() { # sys label epsL rep [alpha] [urgentList]
  local sys=$1 label=$2 el=$3 rep=$4 alpha=${5:-1} ul=${6:-0 1}
  for mode in smallbank custom; do
    echo "### $mode $label a$alpha rep=$rep $(date +%H:%M:%S)"
    env RUN_ID=fair-$mode-$label SYSTEMS=$sys MODE=$mode EPS_LOW=$el PROCESSOR_ALPHA=$alpha REP_START=$rep URGENT_LIST="$ul" \
      bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
  done
}
sysrun() { # label rep
  case $1 in
    A1) one A1 A1 0.75 $2;; FPP) one FPP FPP 0.75 $2;; HTF) one HTF HTF 0.75 $2;;
    BE05) one BE BE05 0.5 $2;; BE075) one BE BE075 0.75 $2;; BE1) one BE BE1 1 $2;;
  esac
}
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
for s in A1 FPP HTF BE05 BE075 BE1; do sysrun $s 1; done
for s in BE1 BE075 BE05 HTF FPP A1; do sysrun $s 2; done
for s in HTF BE075 A1 BE1 FPP BE05; do sysrun $s 3; done
# α 묶음 (네트워크 서명에 α 가 없어 BE075 네트워크를 그대로 쓴다)
for rep in 1 2 3; do for a in 0 3; do
  for mode in smallbank custom; do
    echo "### alpha $a $mode rep=$rep $(date +%H:%M:%S)"
    env RUN_ID=fair-$mode-BE075-a$a SYSTEMS=BE MODE=$mode EPS_LOW=0.75 PROCESSOR_ALPHA=$a REP_START=$rep URGENT_LIST=0 \
      bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
  done
done; done
echo "ALL-DONE $(date +%H:%M:%S)"
