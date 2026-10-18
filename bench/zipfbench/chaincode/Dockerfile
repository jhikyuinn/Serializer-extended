# zipf 체인코드 이미지 (서비스형). network.sh deploy 가 빌드해서 띄운다.
FROM golang:1.23-bookworm AS builder

WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/chaincode .

FROM debian:bookworm-slim
COPY --from=builder /out/chaincode /usr/local/bin/chaincode
EXPOSE 9999
ENTRYPOINT ["chaincode"]
