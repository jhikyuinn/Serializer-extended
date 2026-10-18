# 🔥 Watchdog w-node

프로세서가 버린(abort) 트랜잭션 기록을 Kafka abort 토픽에서 읽어 BFT 합의(BLS 서명)를 거쳐 감사 원장에 남긴다.

- s-node에 등록해 커미티를 받는다. 정족수(`n - (n-1)/3`)에 못 미치면 블록을 만들지 않는다.
- 원장 블록에 abort 토픽의 반영 구간(파티션별 오프셋)을 적어, 노드별 상태 없이 이어서 처리한다.
- 합의에 실패하거나 리더가 멈추면 다시 등록해 새 커미티로 재시도한다.

## 실행 (로컬)

```bash
docker build -t watchdog/w-node:latest .
./run_local.sh 4 mychannel -padding 1000000   # 커미티 최소 4명
```

## 전송 방식

공개본의 w-node 간 합의 메시지는 **QUIC**으로 주고받는다(`transceiver/node/main.go`).

다중 경로 전송(MP2BTP)도 실험했지만, 외부 연구실 라이브러리를 수정해 쓴 것이라 이 저장소에서는 **빼고 비공개로 두었다**. 관련 기록은 [실험 노트](../../docs/lab-notebook.md) §7, §9~§10, §46에 남아 있다.
