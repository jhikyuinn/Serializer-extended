#!/bin/bash

# mongod를 백그라운드가 아닌 포그라운드로 실행
mongod --dbpath /data/db --bind_ip_all --fork --logpath /var/log/mongod.log

# 전송 방식: 공개 저장소에는 QUIC만 있다. 다중 경로 전송(MP2BTP)은 비공개다.
if [ "${WNODE_TRANSPORT:-quic}" != quic ]; then
  echo "WNODE_TRANSPORT=$WNODE_TRANSPORT 는 이 저장소에 없다 (MP2BTP는 비공개). quic 으로 실행한다." >&2
fi
exec ./wnode-quic "$@"
