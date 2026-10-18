#!/bin/bash
# 조회: query.sh <함수> [인자...]
source /work/scripts/env.sh
fn=$1; shift
args="[]"
if [ $# -gt 0 ]; then args=$(printf '"%s",' "$@"); args="[${args%,}]"; fi

setOrg 1
peer chaincode query -C "$CHANNEL" -n "$CC_NAME" -c "{\"function\":\"$fn\",\"Args\":$args}"
