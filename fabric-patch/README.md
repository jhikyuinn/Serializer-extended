# fabric-patch: Serializer용 Fabric 수정분

Fabric 소스 전체(수천 파일)는 저장소에 넣지 않았다. 바꾸거나 새로 만든 파일만 `files/`에 같은 경로로 두었다.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `orderer/consensus/etcdraft/chain.go` | 오더러가 배치를 `<channel>-incoming`으로 보내고, 프로세서가 정한 순서(`<channel>-commit`)로 블록을 만든다. 배치 ID로 결과를 짝짓고, tx별 메타데이터(키·버전·사용자·긴급)만 보낸다(`KAFKA_INCOMING_FORMAT=envelope`이면 예전처럼 envelope 전체) |
| `orderer/consensus/etcdraft/profile.go` | 오더러 계측. 초마다 `[ORDSTAT]`, 배치마다 `[ORDBATCH]` 로그를 남긴다(`ORDERER_PROFILE=0`이면 끈다) |
| `weaveutils/producer`, `weaveutils/consumer` | Kafka producer·consumer 설정(`KAFKA_BROKERS`, `KAFKA_LINGER`, `KAFKA_COMPRESSION`) |
| `weaveutils/txmeta` | envelope에서 순서 결정에 필요한 메타데이터를 뽑는다. 프로세서의 `readTxMeta`와 규칙을 맞춰야 한다 |
| `weaveutils/equalization` | 메시지 패딩 |
| `gossip/gossip/gossip_impl.go` | 피어가 채널 멤버 수를 Kafka `contribution-topic`에 알린다 |

`research-changes.diff`는 연구 중에 이 파일들에 더한 변경이다(배치 ID 매칭, 메타데이터 전송, 브로커 설정화, 압축). 기준은 처음 Kafka 경로를 넣은 커밋이다.

## 적용 방법

기준 소스는 Hyperledger Fabric `main`의 커밋 `08cd8a667`(2024-03 무렵)이다. 2.5 릴리스가 아니다.

```bash
# 저장소 루트에서. bench/zipfbench 는 ../../fabric(= 저장소 루트의 fabric/)을 Fabric 소스로 쓴다
git clone https://github.com/hyperledger/fabric.git fabric
git -C fabric checkout 08cd8a667
cp -r fabric-patch/files/. fabric/

# 이미지: serializer/fabric-{orderer,peer,tools}:latest (값은 fabric/Makefile 과 같다)
for img in orderer peer tools; do
  docker build -f fabric/images/$img/Dockerfile \
    --build-arg UBUNTU_VER=20.04 --build-arg GO_VER=1.21.8 --build-arg FABRIC_VER=2.5.4 \
    --build-arg TARGETARCH=amd64 --build-arg TARGETOS=linux \
    -t serializer/fabric-$img:latest fabric
done

# 비교 기준 A1: 같은 소스에서 chain.go 만 업스트림 원본으로 되돌린 오더러
cd bench/zipfbench && docker buildx build --load --build-context vanilla=images/vanilla \
  -f images/orderer-vanilla.Dockerfile -t zipfbench/fabric-orderer-vanilla:latest ../../fabric
```

- 오더러와 프로세서는 메시지 형식을 함께 바꾸므로 같이 올려야 한다.
