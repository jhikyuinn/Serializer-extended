#!/bin/bash
# 인계 시간 시험: Lease 시간과 w-node의 재등록 대기를 바꿔 가며 활성 s-node를 멈춘다.
#
#   OUT=<결과 폴더> ./failover-test.sh
#
# 설정마다 replica 3개, Byzantine 없는 w-node 10개로 40라운드를 돌리며 5라운드마다
# 활성 pod를 30초 멈춘다(인계 8번). 끝나면 failover.js가 인계 시간을 보여 준다.
#
# 필요한 이미지: Lease 시간을 환경 변수로 받는 s-node, -regtimeout/-regretry/-snodeping을
# 받는 w-node. 끝나면 s-node의 Lease 설정은 기본값으로 되돌린다.
set -u
export MSYS_NO_PATHCONV=1

OUT="${OUT:?OUT=<결과 폴더> 를 지정한다}"
SNODE_IMAGE="${SNODE_IMAGE:-watchdog/s-node:fo-1013}"
WNODE_IMAGE="${WNODE_IMAGE:-watchdog/w-node:fo-1013}"
HERE="$(cd "$(dirname "$0")" && pwd)"
K="kubectl --context docker-desktop -n watchdog"

mkdir -p "$OUT"
# s-node의 peer ID는 pod가 바뀌어도 같다. 재배포 중에는 로그에서 못 읽을 수 있어 먼저 읽어 둔다.
PEER_ID=$($K logs -l snode-role=active --tail=-1 2>/dev/null | grep -o 'Peer ID: .*' | tail -1 | cut -d' ' -f3)
[ -n "$PEER_ID" ] || { echo "s-node peer ID를 읽지 못했다" >&2; exit 1; }
export PEER_ID

$K set image deploy/snode "snode=$SNODE_IMAGE" >/dev/null

run_config() { # run_config 이름 lease renew retry [w-node 인자...]
  local name=$1
  echo "=== $name: lease=$2 renew=$3 retry=$4 w-node: ${*:5}"
  $K set env deploy/snode "SNODE_LEASE_DURATION=$2" "SNODE_RENEW_DEADLINE=$3" "SNODE_RETRY_PERIOD=$4" >/dev/null
  $K rollout status deploy/snode --timeout=240s >/dev/null
  ( cd "$HERE/../../../watchdog/w-node" &&
    IMAGE="$WNODE_IMAGE" NAME_PREFIX=bz BYZANTINE=0 ./run_local.sh 10 mychannel -padding 1000000 "${@:5}" )
  sleep 20
  OUT="$OUT/$name" REPLICAS=3 PROBS=0 ROUNDS=40 DOWN_ROUNDS=3 FREEZE_ACTIVE_EVERY=5 bash "$HERE/run.sh"
}

FAST="-regtimeout 1s -regretry 200ms -snodeping 1s"
run_config baseline 6s 4s 1s
run_config lease3   3s 2s 500ms
run_config fastreg  6s 4s 1s    $FAST
run_config both     3s 2s 500ms $FAST

$K set env deploy/snode SNODE_LEASE_DURATION- SNODE_RENEW_DEADLINE- SNODE_RETRY_PERIOD- >/dev/null
$K rollout status deploy/snode --timeout=240s >/dev/null

node "$(cygpath -w "$HERE/failover.js")" \
  "$(cygpath -w "$OUT/baseline/n3_p0")" "$(cygpath -w "$OUT/lease3/n3_p0")" \
  "$(cygpath -w "$OUT/fastreg/n3_p0")" "$(cygpath -w "$OUT/both/n3_p0")" | tee "$OUT/failover.txt"
