#!/bin/bash
# 로컬 PC에서 w-node 컨테이너를 띄운다.
#   ./run_local.sh [노드 수] [채널] [w-node에 넘길 추가 인자...]
#
# 환경 변수
#   TRANSPORT=quic|mp2btp   w-node 간 합의 메시지 전송 방식 (기본 quic)
#   NAME_PREFIX=wnode       컨테이너 이름 앞부분 (기존 wnode1.. 를 건드리지 않으려면 바꾼다)
#
# 예) 합의 메시지에 채우는 블록 크기를 1MB로:  ./run_local.sh 3 mychannel -padding 1000000
#
# s-node(로컬 Kubernetes의 Service)와 Kafka는 호스트 PC에 열려 있다고 가정한다.
set -euo pipefail

# Git Bash가 /entrypoint.sh 같은 컨테이너 경로를 Windows 경로로 바꾸지 않게 한다
export MSYS_NO_PATHCONV=1

NODE_COUNT="${1:-3}"
CHANNEL="${2:-mychannel}"
shift $(( $# > 2 ? 2 : $# ))
TRANSPORT="${TRANSPORT:-quic}"
IMAGE="${IMAGE:-watchdog/w-node:latest}"
NAME_PREFIX="${NAME_PREFIX:-wnode}"
# MP2BTP가 다중 경로(NUM_MULTIPATH = 2)로 설정돼 있어 노드마다 네트워크가 두 개 필요하다.
# QUIC은 하나면 되지만 같은 구성으로 띄워 둔다.
NET_A="${NET_A:-wdn1}"
NET_B="${NET_B:-wdn2}"
HOST="${HOST:-host.docker.internal}"
# 클라우드: s-node(Kubernetes Service)와 Kafka 가 다른 곳이면 따로 준다(deploy/cloud). 기본은 둘 다 HOST
SNODE_HOST="${SNODE_HOST:-$HOST}"
BROKER_HOST="${BROKER_HOST:-$HOST}"
# libp2p 주소: IP 면 /ip4, 이름이면 /dns4
case "$SNODE_HOST" in *[!0-9.]*) SNODE_MADDR="/dns4/$SNODE_HOST" ;; *) SNODE_MADDR="/ip4/$SNODE_HOST" ;; esac

# s-node의 peer ID는 Kafka snode-keys의 키에서 나온다. 활성 pod의 로그에서 읽는다.
PEER_ID="${PEER_ID:-$(kubectl -n watchdog logs -l snode-role=active --tail=-1 2>/dev/null | grep -o 'Peer ID: .*' | tail -1 | cut -d' ' -f3)}"
if [ -z "$PEER_ID" ]; then
  echo "s-node의 peer ID를 찾지 못했다. PEER_ID=... 로 지정한다." >&2
  exit 1
fi

for net in "$NET_A" "$NET_B"; do
  docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
done

for i in $(seq 1 "$NODE_COUNT"); do
  name="$NAME_PREFIX$i"
  docker rm -f "$name" >/dev/null 2>&1 || true
  # MP2BTP의 fectun이 TUN 장치와 iptables를 쓰므로 privileged가 필요하다.
  # MP2BTP가 시작하면서 컨테이너의 nat 테이블을 비워 Docker 내장 DNS가 끊긴다.
  # 호스트 이름은 /etc/hosts에 넣어 DNS 없이도 풀리게 한다.
  docker create --name "$name" --hostname "$name" --privileged --network "$NET_A" \
    --add-host "$HOST:host-gateway" -e WNODE_TRANSPORT="$TRANSPORT" "$IMAGE" \
    /entrypoint.sh \
    -snode "$SNODE_HOST" \
    -broker "$BROKER_HOST" \
    -libp2p "$SNODE_MADDR/tcp/4001/p2p/$PEER_ID" \
    -channel "$CHANNEL" "$@" >/dev/null
  # 시작 전에 두 번째 네트워크를 붙여야 w-node가 두 주소를 모두 읽는다
  docker network connect "$NET_B" "$name"
done

# 한꺼번에 시작한다. s-node는 등록이 모인 3초 동안의 노드로 커미티를 만들기 때문에,
# 차례로 띄우면 늦게 등록한 노드가 다른 커미티로 갈라진다.
for i in $(seq 1 "$NODE_COUNT"); do
  docker start "$NAME_PREFIX$i" >/dev/null &
done
wait
echo "started $NODE_COUNT w-node(s) ($TRANSPORT)"
