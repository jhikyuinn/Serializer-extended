# A1: 수정된 Fabric(../../fabric)과 같은 소스에서 오더러의 reordering만 뺀 오더러.
#
# 수정된 Fabric에서 동작이 바뀐 곳은 orderer/consensus/etcdraft/chain.go 하나다
# (배치를 Kafka로 보내고 processor가 돌려준 순서로 블록을 만든다). 그 파일만
# 업스트림 원본(hyperledger/fabric 08cd8a667, vanilla/chain.go)으로 바꿔 빌드한다.
# 나머지(피어, 도구)는 B와 같은 이미지를 쓴다.
#
#   docker buildx build --load --build-context vanilla=images/vanilla \
#     -f images/orderer-vanilla.Dockerfile -t zipfbench/fabric-orderer-vanilla:latest ../../fabric
#
# 원본 ../../fabric/images/orderer/Dockerfile 과 같고 COPY 한 줄만 더했다.
ARG UBUNTU_VER=20.04
FROM ubuntu:${UBUNTU_VER} as builder
ARG TARGETARCH=amd64
ARG TARGETOS=linux
ARG FABRIC_VER=2.5.4
ARG GO_VER=1.21.8
ARG GO_TAGS
RUN apt update && apt install -y \
    git \
    gcc \
    curl \
    make
RUN curl -sL https://go.dev/dl/go${GO_VER}.${TARGETOS}-${TARGETARCH}.tar.gz | tar zxf - -C /usr/local
ENV PATH="/usr/local/go/bin:$PATH"
ADD . .
COPY --from=vanilla chain.go orderer/consensus/etcdraft/chain.go
RUN make orderer GO_TAGS=${GO_TAGS} FABRIC_VER=${FABRIC_VER}

FROM ubuntu:${UBUNTU_VER}
ARG FABRIC_VER=2.5.4
RUN echo 'hosts: files dns' > /etc/nsswitch.conf
ENV     FABRIC_CFG_PATH /etc/hyperledger/fabric
ENV     FABRIC_VER      ${FABRIC_VER}
COPY    --from=builder  build/bin/orderer           /usr/local/bin
COPY    --from=builder  sampleconfig/msp            ${FABRIC_CFG_PATH}/msp
COPY    --from=builder  sampleconfig/orderer.yaml   ${FABRIC_CFG_PATH}
COPY    --from=builder  sampleconfig/configtx.yaml  ${FABRIC_CFG_PATH}
VOLUME  /etc/hyperledger/fabric
VOLUME  /var/hyperledger
EXPOSE  7050
CMD     [ "orderer", "start" ]
