# # WDN
# # Stage 1: Dependencies만 설치 (캐시용)
# FROM golang:1.23-bullseye AS deps

# WORKDIR /app

# COPY go.mod go.sum ./

# ENV GOPROXY=direct

# # Stage 2: Build 및 실행 환경
# FROM golang:1.23-bullseye

# RUN apt-get update && apt-get install -y \
#     gnupg \
#     curl \
#     git \
#     netcat \
#     jq \
#     iptables

# RUN curl -fsSL https://pgp.mongodb.com/server-6.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-6.0.gpg && \
#     echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/debian bullseye/mongodb-org/6.0 main" | tee /etc/apt/sources.list.d/mongodb-org-6.0.list && \
#     apt-get update && apt-get install -y mongodb-org

# RUN mkdir -p /data/db

# COPY go.mod go.sum ./

# COPY . .

# RUN go build -o wnode  -mod=readonly  ./transceiver/node/main.go 

# COPY entrypoint.sh /entrypoint.sh
# RUN chmod +x /entrypoint.sh

# CMD ["/entrypoint.sh"]

# WDN (QUIC). 다중 경로 전송(MP2BTP)은 외부 라이브러리라 공개 저장소에서 뺐다.
# # Stage 1: Dependencies만 설치 (캐시용)
FROM golang:1.23-bookworm AS deps

WORKDIR /app

COPY go.mod go.sum ./

ENV GOPROXY=https://proxy.golang.org,direct
ENV GOSUMDB=sum.golang.org

RUN go mod download

# Stage 2: Build 및 실행 환경
# bullseye의 apt 저장소가 내려가 bookworm과 MongoDB 7.0을 쓴다
FROM golang:1.23-bookworm

RUN apt-get update && apt-get install -y \
    gnupg \
    curl \
    git \
    netcat-openbsd \
    jq \
    iptables

RUN curl -fsSL https://pgp.mongodb.com/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg && \
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list && \
    apt-get update && apt-get install -y mongodb-org

RUN mkdir -p /data/db

WORKDIR /app

# # deps 스테이지에서 다운받은 모듈 복사
COPY --from=deps /go/pkg /go/pkg

COPY go.mod go.sum ./

COPY . .

# w-node 간 합의 메시지를 QUIC으로 주고받는다 (main.go)
RUN go build -o wnode-quic -mod=readonly ./transceiver/node/main.go

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]