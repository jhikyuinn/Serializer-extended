# ------------------ Build Stage ------------------
FROM golang:1.23-bullseye AS builder

WORKDIR /src

# 의존성 레이어 캐시 (bls-eth-go-binary는 go.mod의 replace 대상)
COPY go.mod go.sum ./
COPY bls-eth-go-binary ./bls-eth-go-binary
RUN go mod download

COPY . .

# go-libp2p v0.32에서 peer.ID.Pretty()가 제거되어 pubsub v0.9.0을 패치해야 한다
RUN go mod vendor && \
    sed -i 's/p.Pretty()/p.String()/g' vendor/github.com/libp2p/go-libp2p-pubsub/gossipsub.go

# go mod vendor는 BLS의 헤더와 정적 라이브러리를 복사하지 않으므로 원본 위치를 지정한다
RUN CGO_ENABLED=1 \
    CGO_CFLAGS="-I/src/bls-eth-go-binary/bls/include" \
    CGO_LDFLAGS="-L/src/bls-eth-go-binary/bls/lib/linux/$(go env GOARCH)" \
    go build -mod=vendor -o /out/validator ./validator

# ------------------ Runtime Stage ------------------
FROM debian:bookworm-slim

# bullseye의 apt 저장소가 내려가 있어 패키지 설치 없이 빌드 단계의 인증서를 가져온다
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

WORKDIR /app/validator

COPY --from=builder /out/validator ./validator
# wp2p는 소스 경로 기준(../testdata/ca.pem)으로 루트 CA를 읽는다
COPY --from=builder /src/testdata/ca.pem /src/testdata/ca.pem

# gRPC(멤버십), NAT 확인용 TCP, libp2p, 상태 확인 HTTP
EXPOSE 16220 11730 4001 8080

ENTRYPOINT ["./validator"]
