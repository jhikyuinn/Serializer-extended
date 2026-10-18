#!/bin/bash
# [내 PC] 직접 만든 이미지를 역할별 tar.gz 로 저장한다 (deploy/cloud/images/). 공개 이미지는 VM 에서 받는다.
# w-node 이미지(약 4 GB)는 올리지 않고 Watchdog VM 에서 소스로 빌드한다(50-watchdog.sh).
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
mkdir -p images
save() { # save <파일> <이미지...>
  local out="images/$1"; shift
  for i in "$@"; do docker image inspect "$i" >/dev/null || { echo "이미지 $i 가 없다" >&2; exit 1; }; done
  echo "== $out: $*"
  docker save "$@" | gzip -1 > "$out"
}
save fabric.tar.gz   "$ORDERER_IMAGE" "$PEER_IMAGE" "$TOOLS_IMAGE" "$VANILLA_ORDERER_IMAGE" "$CC_IMAGE"
save kafka.tar.gz    "$PROCESSOR_IMAGE"
save client.tar.gz   "$CALIPER_IMAGE"
save watchdog.tar.gz "$SNODE_IMAGE"
ls -lh images/
