package main

import (
	"fmt"
	"math"
)

// 행렬로 구현한 예전 ε-ordering (2026-10-16 인접 리스트로 바꾸기 전). 새 구현과 결과가 같은지 비교하는 기준이다.

func scheduleEpsilonMatrixRef(txs []TxMeta, stats map[string]*UserStat) (order []int, aborted []int) {
	written := make(map[string]bool) // 상태 S: 이미 놓인 트랜잭션이 쓴 키

	var medium, low []int
	for i, tx := range txs {
		switch {
		case len(tx.Writes) == 0: // 읽기 전용
			order = append(order, i)
		case tx.Urgency:
			medium = append(medium, i)
		default:
			low = append(low, i)
		}
	}

	statOf := func(user string) *UserStat {
		if s, ok := stats[user]; ok {
			return s
		}
		s := &UserStat{}
		stats[user] = s
		return s
	}
	score := func(i int) float64 {
		return math.Exp(abortAlpha * float64(statOf(txs[i].User).Abort))
	}
	abort := func(i int) {
		aborted = append(aborted, i)
		statOf(txs[i].User).Abort++
	}
	place := func(i int) {
		order = append(order, i)
		for _, k := range txs[i].Writes {
			written[k] = true
		}
	}
	stale := func(i int) bool {
		for _, k := range txs[i].Reads {
			if written[k] {
				return true
			}
		}
		return false
	}

	// 그룹(긴급, 일반)마다: 그래프에 들어간 수, 그중 상태 S 로 버린 수, 고리로 버린 수,
	// 그래프 없이 붙인 수, 그래프 없이 상태 S 로 버린 수
	type epsCount struct{ graph, graphStale, graphCycle, tailPlaced, tailStale int }
	var counts [2]epsCount

	epsilonOrdering := func(group []int, eps float64, cnt *epsCount) {
		k := int(math.Ceil(eps * float64(len(group))))
		if k > len(group) {
			k = len(group)
		}
		cnt.graph = k

		// T_ε: 앞 그룹이 쓴 키를 읽은 것은 먼저 버린다
		var te []int
		for _, i := range group[:k] {
			if stale(i) {
				abort(i)
				cnt.graphStale++
			} else {
				te = append(te, i)
			}
		}

		// 충돌 행렬: m[r][c] = T_r 이 쓴 키를 T_c 가 읽는다 (T_c 가 T_r 보다 앞에 와야 한다)
		n := len(te)
		m := make([][]bool, n)
		for r := range m {
			m[r] = make([]bool, n)
			ws := make(map[string]bool, len(txs[te[r]].Writes))
			for _, key := range txs[te[r]].Writes {
				ws[key] = true
			}
			for c := 0; c < n; c++ {
				if r == c {
					continue
				}
				for _, key := range txs[te[c]].Reads {
					if ws[key] {
						m[r][c] = true
						break
					}
				}
			}
		}
		alive := make([]bool, n)
		for i := range alive {
			alive[i] = true
		}

		// Algorithm 3: 간선마다, 그 간선을 지나는 고리가 남아 있으면 abort 점수가 가장 작은 것을 버린다
		for r := 0; r < n; r++ {
			for c := 0; c < n; c++ {
				for alive[r] && alive[c] && m[r][c] {
					cycle := findCycleMatrixRef(m, alive, r, c)
					if cycle == nil {
						break
					}
					victim := cycle[0]
					for _, v := range cycle[1:] {
						sv, sb := score(te[v]), score(te[victim])
						if sv < sb || (sv == sb && te[v] > te[victim]) {
							victim = v
						}
					}
					alive[victim] = false
					abort(te[victim])
					cnt.graphCycle++
				}
			}
		}

		// Algorithm 4: 위상 정렬(m 의 간선 방향, 같으면 들어온 순서) 후 뒤집기
		indeg := make([]int, n)
		for r := 0; r < n; r++ {
			for c := 0; c < n; c++ {
				if alive[r] && alive[c] && m[r][c] {
					indeg[c]++
				}
			}
		}
		var sorted []int
		done := make([]bool, n)
		for {
			next := -1
			for v := 0; v < n; v++ {
				if alive[v] && !done[v] && indeg[v] == 0 {
					next = v
					break
				}
			}
			if next < 0 {
				break
			}
			done[next] = true
			sorted = append(sorted, next)
			for c := 0; c < n; c++ {
				if alive[c] && m[next][c] {
					indeg[c]--
				}
			}
		}
		for j := len(sorted) - 1; j >= 0; j-- {
			place(te[sorted[j]])
		}

		// 나머지: 그래프 없이 들어온 순서대로 상태 S 만 본다
		for _, i := range group[k:] {
			if stale(i) {
				abort(i)
				cnt.tailStale++
			} else {
				place(i)
				cnt.tailPlaced++
			}
		}
	}

	epsilonOrdering(medium, epsilonUrgent, &counts[0])
	epsilonOrdering(low, epsilonLow, &counts[1])

	u, l := counts[0], counts[1]
	fmt.Printf("[Epsilon] eps_urgent=%.2f eps_low=%.2f readonly=%d | urgent %d: graph %d (stale %d, cycle %d) tail %d (placed %d, stale %d)"+
		" | low %d: graph %d (stale %d, cycle %d) tail %d (placed %d, stale %d) | aborted=%d\n",
		epsilonUrgent, epsilonLow, len(txs)-len(medium)-len(low),
		len(medium), u.graph, u.graphStale, u.graphCycle, len(medium)-u.graph, u.tailPlaced, u.tailStale,
		len(low), l.graph, l.graphStale, l.graphCycle, len(low)-l.graph, l.tailPlaced, l.tailStale, len(aborted))
	return order, aborted
}

// findCycleMatrixRef returns a cycle through the edge r→c (as matrix indices, starting at r), or nil.
// c 에서 출발해 행렬 순서의 깊이 우선 탐색으로 r 로 돌아오는 길을 찾는다.
func findCycleMatrixRef(m [][]bool, alive []bool, r, c int) []int {
	n := len(m)
	visited := make([]bool, n)
	path := []int{r}
	var dfs func(v int) bool
	dfs = func(v int) bool {
		visited[v] = true
		path = append(path, v)
		for w := 0; w < n; w++ {
			if !alive[w] || !m[v][w] {
				continue
			}
			if w == r {
				return true
			}
			if !visited[w] && dfs(w) {
				return true
			}
		}
		path = path[:len(path)-1]
		return false
	}
	if dfs(c) {
		return path
	}
	return nil
}
