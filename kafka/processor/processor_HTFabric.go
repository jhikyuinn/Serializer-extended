package main

import (
	"fmt"
	"sort"
)

// HTFabric (Song et al., "HTFabric: A Fast Re-ordering and Parallel Re-execution Method for a
// High-Throughput Blockchain", CIKM 2024)의 WARD(Write-Ascending, Read-Descending) 정렬.
// 비교 실험에서 Kafka 경로와 사용자 통계 기록은 Serializer와 같고, 순서를 정하는 부분만 다르다.
//
// 키를 꼭짓점, 트랜잭션을 하이퍼엣지(읽은 키 → 쓴 키)로 본다 (Definition 3.1~3.3).
//   in-deg(k)  = k를 쓰는 트랜잭션 수
//   out-deg(k) = k를 읽는 트랜잭션 수
//   wc(T) = T가 쓰는 키들의 out-deg 합 (T의 쓰기 때문에 무효가 될 수 있는 트랜잭션 수)
//   rc(T) = T가 읽는 키들의 in-deg 합  (T를 무효로 만들 수 있는 트랜잭션 수)
// wc 오름차순, 같으면 rc 내림차순, 그래도 같으면 들어온 순서로 놓는다 (Algorithm 1의 Compare).
//
// 논문 Algorithm 1의 CalcDeg는 읽은 키에 in-deg, 쓴 키에 out-deg를 더하도록 적혀 있다. 이는
// Definition 3.2와 Figure 4의 예(K1: in-deg 2 = 쓰는 T2·T3, out-deg 3 = 읽는 T2·T3·T6)와
// 반대이므로, 예와 맞는 정의를 따른다.
//
// WARD는 트랜잭션을 버리지 않는다. HTFabric은 남은 충돌을 fast peer에서 TSP로 나눠 병렬로
// 재실행해 살린다(4절). 이 시스템의 피어에는 재실행이 없으므로 그 부분은 재현하지 않는다.
// 남은 충돌은 피어가 MVCC로 무효 처리한다.

func scheduleHTFabric(txs []TxMeta, _ map[string]*UserStat) (order []int, aborted []int) {
	n := len(txs)
	reads := make([][]string, n)
	writes := make([][]string, n)
	inDeg := make(map[string]int)  // 쓰는 트랜잭션 수
	outDeg := make(map[string]int) // 읽는 트랜잭션 수
	for i, tx := range txs {
		reads[i] = uniqueKeys(tx.Reads)
		writes[i] = uniqueKeys(tx.Writes)
		for _, k := range reads[i] {
			outDeg[k]++
		}
		for _, k := range writes[i] {
			inDeg[k]++
		}
	}

	rc := make([]int, n)
	wc := make([]int, n)
	for i := 0; i < n; i++ {
		for _, k := range writes[i] {
			wc[i] += outDeg[k]
		}
		for _, k := range reads[i] {
			rc[i] += inDeg[k]
		}
	}

	order = make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		x, y := order[a], order[b]
		if wc[x] != wc[y] {
			return wc[x] < wc[y]
		}
		if rc[x] != rc[y] {
			return rc[x] > rc[y]
		}
		return x < y
	})

	fmt.Printf("[HTFabric] WARD ordered %d\n", n)
	return order, nil
}

func uniqueKeys(keys []string) []string {
	seen := make(map[string]bool, len(keys))
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}
