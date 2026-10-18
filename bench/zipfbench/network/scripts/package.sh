#!/bin/bash
# 서비스형 체인코드 패키지를 만들어 두 피어에 설치하고, 패키지 ID를 파일로 남긴다.
# 패키지에는 코드가 아니라 체인코드 서버의 주소만 들어간다.
source /work/scripts/env.sh
cd /work
PKG=channel-artifacts/${CC_NAME}_${CC_VERSION}.tar.gz

tmp=$(mktemp -d)
cat > "$tmp/connection.json" <<JSON
{"address": "${CC_ADDRESS}", "dial_timeout": "10s", "tls_required": false}
JSON
cat > "$tmp/metadata.json" <<JSON
{"type": "ccaas", "label": "${CC_NAME}_${CC_VERSION}"}
JSON
tar -C "$tmp" -czf "$tmp/code.tar.gz" connection.json
tar -C "$tmp" -czf "$PKG" metadata.json code.tar.gz
rm -rf "$tmp"

setOrg 1
PKG_ID=$(peer lifecycle chaincode calculatepackageid "$PKG")
echo "$PKG_ID" > channel-artifacts/${CC_NAME}.pkgid
echo "package id: $PKG_ID"

for org in 1 2; do
  setOrg $org
  echo "== Org$org 피어에 설치"
  if peer lifecycle chaincode queryinstalled 2>/dev/null | grep -q "$PKG_ID"; then
    echo "이미 설치돼 있다"
  else
    peer lifecycle chaincode install "$PKG"
  fi
done
