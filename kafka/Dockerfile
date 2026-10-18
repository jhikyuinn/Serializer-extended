# ------------------ Build Stage ------------------
FROM golang:1.24-bookworm AS builder

WORKDIR /src
COPY . .

# processor 폴더 전체를 빌드한다 (정렬 알고리즘: processor.go, processor_Fabricplus.go, processor_HTFabric.go)
RUN CGO_ENABLED=1 go build -mod=vendor -o /out/processor ./processor \
    || CGO_ENABLED=1 go build -mod=mod -o /out/processor ./processor

# ------------------ Runtime Stage ------------------
FROM debian:bookworm-slim

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY --from=builder /out/processor ./processor
# 컨테이너 안에서는 HTTP/3 서버가 ./src 아래의 인증서를 읽는다
COPY --from=builder /src/http/testdata/cert.pem /src/http/testdata/priv.key ./src/

# 채널 목록 조회용 HTTP/3 (QUIC)
EXPOSE 8082/udp

ENTRYPOINT ["./processor"]
