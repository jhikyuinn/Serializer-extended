# bench: 벤치마크와 집계

| 폴더 | 내용 |
|---|---|
| [`zipfbench/`](zipfbench/README.md) | Fabric 네트워크(오더러 1, 피어 2), smallbank·custom 체인코드, Caliper 워크로드(사용자 5명, 사용자별 지연, VIP 긴급 tx, Zipf 키 분포), 실행 스크립트 |
| `scripts/` | 실험 묶음 실행(`batch.sh`, `cloud-sb.sh` 등)과 집계·그림 스크립트(`cloudfigs*.js`, `blocktime.js`, `ordstat.js` 등) |

## 비교 대상 (`SYSTEMS`)

| 이름 | 내용 |
|---|---|
| `A1` | 같은 소스 Fabric. 오더러의 Kafka 경로만 업스트림으로 되돌렸다(기준선) |
| `A2` | 공식 Fabric 2.5.10 이미지 |
| `BE` | Serializer: 논문의 ε-ordering(`-algo epsilon`) |
| `FPP` | Fabric++ 재정렬(`-algo fabricpp`) |
| `HTF` | HTFabric WARD 정렬(`-algo htfabric`). 피어 쪽 재실행(TSP)은 뺐다 |
| `B` | 연구 중 만든 스케줄러(SCC 단위 abort, 사용자 실패율 기준 희생자). 논문 알고리즘과 다르므로 별도 이름 |

## 실행 예

```bash
cd bench/zipfbench
RUN_ID=demo SYSTEMS="A1 BE" URGENT_LIST=0 REPS=1 TPS=250 DURATION=30 ./userbench.sh
node aggregate-users.js results/demo
```

- 결과는 `zipfbench/results/<RUN_ID>/`에 쌓인다(저장소에는 넣지 않는다).
- 프로세서는 `../../kafka`의 compose를 다시 띄워 바꾼다(`KAFKA_DIR`로 바꿀 수 있다).
- 클라우드에서는 [deploy/cloud](../deploy/cloud/README.md)의 `run.sh`가 같은 스크립트를 부른다.
- 그림 스크립트는 `zipfbench/results/cloud/`를 읽고 [experiments/cloud-figs](../experiments/cloud-figs/README.md)에 쓴다.
