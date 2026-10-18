#!/bin/bash
# 오더러와 두 피어를 채널에 참여시킨다.
source /work/scripts/env.sh
cd /work
BLOCK=channel-artifacts/$CHANNEL.block

echo "== 오더러를 채널 $CHANNEL 에 참여"
for i in $(seq 1 30); do
  if osnadmin channel join --channelID "$CHANNEL" --config-block "$BLOCK" -o "$ORDERER_ADMIN" \
      --ca-file "$ORDERER_CA" --client-cert "$ORDERER_TLS_DIR/server.crt" --client-key "$ORDERER_TLS_DIR/server.key"; then
    break
  fi
  [ "$i" = 30 ] && { echo "오더러가 채널에 참여하지 못했다"; exit 1; }
  sleep 2
done

for org in 1 2; do
  setOrg $org
  echo "== Org$org 피어를 채널에 참여"
  for i in $(seq 1 30); do
    if peer channel join -b "$BLOCK"; then break; fi
    [ "$i" = 30 ] && { echo "Org$org 피어가 채널에 참여하지 못했다"; exit 1; }
    sleep 2
  done
done

setOrg 1
peer channel list
