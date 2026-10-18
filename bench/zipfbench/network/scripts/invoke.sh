#!/bin/bash
# 트랜잭션 호출: invoke.sh <함수> [인자...]
source /work/scripts/env.sh
fn=$1; shift
args="[]"
if [ $# -gt 0 ]; then args=$(printf '"%s",' "$@"); args="[${args%,}]"; fi

setOrg 1
peer chaincode invoke "${ORDERER_ARGS[@]}" -C "$CHANNEL" -n "$CC_NAME" "${BOTH_PEERS[@]}" \
  --waitForEvent -c "{\"function\":\"$fn\",\"Args\":$args}"
