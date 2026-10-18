# Caliper에 Fabric SDK(2.2)를 미리 묶어 둔 이미지. 실행할 때마다 npm install을 하지 않게 한다.
FROM hyperledger/caliper:0.6.0
RUN caliper bind --caliper-bind-sut fabric:2.2
# 사용자별 실험(workload/users.js)은 프로세서의 abort 토픽을 읽어 버려진 트랜잭션을 바로 안다
# 프로세서(goka)는 Snappy 로 압축해 보내므로 Snappy 코덱(순수 JS)도 넣는다
RUN npm install -g kafkajs@2.2.4 kafkajs-snappy@1.1.0
ENV NODE_PATH=/home/node/.npm-global/lib/node_modules
