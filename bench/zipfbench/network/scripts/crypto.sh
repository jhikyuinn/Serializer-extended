#!/bin/bash
# 조직 인증서와 채널 제네시스 블록을 만든다. 노드를 띄우기 전에 한 번 실행한다.
#
# BATCH_SIZE(MaxMessageCount), BATCH_TIMEOUT(예: 5s) 을 주면 그 값으로 바꾼 configtx 로 만든다.
# 경로가 configtx.yaml 기준 상대 경로(../organizations)이므로 같은 깊이의 configtx-run/ 에 복사해 고친다.
source /work/scripts/env.sh
cd /work

if [ -d organizations/peerOrganizations ]; then
  echo "인증서가 이미 있다. 새로 만들려면 먼저 './network.sh down'을 실행한다."
else
  for cfg in orderer org1 org2; do
    cryptogen generate --config=crypto-config/$cfg.yaml --output=organizations
  done
fi

CFG=/work/configtx
if [ -n "${BATCH_SIZE:-}${BATCH_TIMEOUT:-}" ]; then
  CFG=/work/configtx-run
  rm -rf "$CFG" && cp -r /work/configtx "$CFG"
  [ -n "${BATCH_SIZE:-}" ] && sed -i "s/^\(    MaxMessageCount:\).*/\1 $BATCH_SIZE/" "$CFG/configtx.yaml"
  [ -n "${BATCH_TIMEOUT:-}" ] && sed -i "s/^\(  BatchTimeout:\).*/\1 $BATCH_TIMEOUT/" "$CFG/configtx.yaml"
fi
echo "== 배치: $(grep -E '^  BatchTimeout:|^    MaxMessageCount:' "$CFG/configtx.yaml" | tr -s ' ' | tr '\n' ' ')"

mkdir -p channel-artifacts
FABRIC_CFG_PATH=$CFG configtxgen -profile ChannelUsingRaft \
  -outputBlock channel-artifacts/$CHANNEL.block -channelID "$CHANNEL"
