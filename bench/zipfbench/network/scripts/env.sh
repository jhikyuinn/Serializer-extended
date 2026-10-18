#!/bin/bash
# cli 컨테이너 안에서 쓰는 공통 설정. 다른 스크립트가 source 한다.
set -euo pipefail

export CHANNEL="${CHANNEL:-mychannel}"
export CC_NAME="${CC_NAME:-zipf}"
export CC_VERSION="${CC_VERSION:-1.0}"
export CC_SEQUENCE="${CC_SEQUENCE:-1}"
# 체인코드 서버 컨테이너의 네트워크 안 주소 (network.sh 가 이 이름으로 띄운다)
export CC_ADDRESS="${CC_ADDRESS:-${CC_NAME}.chaincode:9999}"

ORG_DIR=/work/organizations
export ORDERER=orderer.example.com:7050
export ORDERER_ADMIN=orderer.example.com:7053
ORDERER_TLS_DIR=$ORG_DIR/ordererOrganizations/example.com/orderers/orderer.example.com/tls
export ORDERER_CA=$ORDERER_TLS_DIR/ca.crt

PEER1=peer0.org1.example.com:7051
PEER2=peer0.org2.example.com:7051
PEER1_CA=$ORG_DIR/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
PEER2_CA=$ORG_DIR/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt

# 이후의 peer 명령이 어느 조직의 관리자로 어느 피어에 붙을지 정한다
setOrg() {
  local n=$1
  export CORE_PEER_LOCALMSPID="Org${n}MSP"
  export CORE_PEER_MSPCONFIGPATH=$ORG_DIR/peerOrganizations/org${n}.example.com/users/Admin@org${n}.example.com/msp
  export CORE_PEER_ADDRESS=peer0.org${n}.example.com:7051
  export CORE_PEER_TLS_ROOTCERT_FILE=$ORG_DIR/peerOrganizations/org${n}.example.com/peers/peer0.org${n}.example.com/tls/ca.crt
}

# 두 조직의 피어 모두에게 보증을 받는 호출에 붙이는 인자
BOTH_PEERS=(--peerAddresses "$PEER1" --tlsRootCertFiles "$PEER1_CA" --peerAddresses "$PEER2" --tlsRootCertFiles "$PEER2_CA")
ORDERER_ARGS=(-o "$ORDERER" --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA")
