#!/bin/bash
# [① Client VM] Caliper 이미지만 있으면 된다. 실행할 때마다 Fabric VM 의 run-users.sh 가
# 설정·인증서를 $WORK/zipfbench-client 로 보내고 이 VM 의 Docker 로 Caliper 를 띄운다.
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
sudo docker image inspect "$CALIPER_IMAGE" >/dev/null || { echo "$CALIPER_IMAGE 가 없다 (00-export-images.sh)" >&2; exit 1; }
mkdir -p "$WORK/zipfbench-client"
echo "role-client 끝"
