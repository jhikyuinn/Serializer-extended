#!/bin/bash
# 설치된 체인코드를 두 조직이 승인하고 채널에 커밋한다.
# B(reordering)에서는 승인과 커밋도 오더러 → Kafka → 프로세서 → 오더러 경로를 탄다.
# 보증 정책은 실험 설정대로 두 조직 중 한 피어면 된다.
source /work/scripts/env.sh
cd /work
PKG_ID=$(cat channel-artifacts/${CC_NAME}.pkgid)
POLICY="OR('Org1MSP.peer','Org2MSP.peer')"

for org in 1 2; do
  setOrg $org
  echo "== Org$org 승인"
  peer lifecycle chaincode approveformyorg "${ORDERER_ARGS[@]}" --channelID "$CHANNEL" --name "$CC_NAME" \
    --version "$CC_VERSION" --package-id "$PKG_ID" --sequence "$CC_SEQUENCE" --signature-policy "$POLICY"
done

setOrg 1
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --signature-policy "$POLICY"

echo "== 커밋"
peer lifecycle chaincode commit "${ORDERER_ARGS[@]}" --channelID "$CHANNEL" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" "${BOTH_PEERS[@]}"

peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME"
