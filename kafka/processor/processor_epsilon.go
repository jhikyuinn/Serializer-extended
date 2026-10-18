package main

import (
	"container/heap"
	"fmt"
	"math"
	"sort"
)

// Serializer 논문(IEEE Access) II.C절의 ε-ordering (Algorithm 1~4).
// -algo epsilon 으로 고른다. 기존 스케줄러(-algo serializer, scheduleBatch)는 비교 기준으로 그대로 둔다.
//
// Algorithm 1 (TX-categorizing)
//   읽기 전용은 바로 T_serial 에 넣는다(높은 우선순위). 긴급은 T_medium, 나머지는 T_low 로 나눈 뒤
//   ε-ordering(T_medium, ε_urgent), ε-ordering(T_low, ε_low) 순서로 처리한다.
// Algorithm 2 (ε-ordering)
//   앞의 k = ⌈ε·|T|⌉ 개(T_ε)만 충돌 행렬을 만들어 고리를 없애고(Algorithm 3) 위상 정렬한다(Algorithm 4).
//   나머지는 그래프 없이 들어온 순서대로, 상태 S 와 어긋나면 abort, 아니면 T_serial 뒤에 붙인다.
//   ε 가 0 에 가까울수록 계산이 줄고, 1 이면 모두 그래프로 처리한다.
// Algorithm 3 (Cycle-removal)
//   충돌 행렬의 간선마다 그 간선을 지나는 고리를 찾고, 고리 안에서 abort 점수 f_i(n_i) = e^{α·n_i}
//   (n_i = 사용자 i 가 지금까지 abort 된 수)가 가장 작은 트랜잭션을 버린다.
// Algorithm 4 (Transaction-schedule)
//   위상 정렬한 뒤 뒤집는다.
//
// 해석한 부분 (논문 의사코드 그대로는 동작하지 않거나 이 시스템의 결정과 맞지 않는 곳)
//   - 상태 S: 논문은 "이전 블록으로 갱신된 상태"다. 프로세서는 상태를 두지 않기로 했으므로(§18)
//     "이 배치에서 이미 T_serial 에 놓인 트랜잭션이 쓴 키"로 본다. 그런 키를 읽은 트랜잭션은 그 뒤에
//     놓이면 피어에서 무효가 되므로 abort 한다. 배치 사이의 낡은 읽기는 보지 못한다.
//     T_ε 안의 트랜잭션도 앞 그룹(긴급)이 쓴 키를 읽었으면 그래프에 넣기 전에 abort 한다.
//   - Algorithm 2 의 행렬은 의사코드상 column > row 인 칸만 채운다. 그러면 고리가 생길 수 없어
//     Algorithm 3 이 하는 일이 없다. Figure 9 의 행렬처럼 모든 칸(row ≠ column)을 채운다.
//   - Algorithm 3 은 간선마다 고리 하나만 찾는다. 한 번 버리고 나서도 같은 간선을 지나는 다른 고리가
//     남을 수 있으므로, 그 간선에 고리가 없어질 때까지 반복한다. 고리는 행렬 순서의 깊이 우선 탐색으로 찾는다.
//   - abort 점수가 같으면 늦게 들어온 것을 버린다. 같은 배치에서 버린 것은 바로 n_i 에 더한다.
//   - α 는 모든 사용자에게 같다(-alpha). α > 0 이면 e^{α·n} 은 n 에 대해 증가하므로 n 이 가장 작은
//     사용자를 고르는 것과 같다.

var (
	epsilonUrgent = 1.0
	epsilonLow    = 1.0
	abortAlpha    = 1.0
)

func scheduleEpsilon(txs []TxMeta, stats map[string]*UserStat) (order []int, aborted []int) {
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

		// 충돌 그래프: out[r] 은 T_r 이 쓴 키를 읽는 T_c 들(T_c 가 T_r 보다 앞에 와야 한다), 번호 순.
		// 논문의 k×k 행렬 M 과 같은 간선을 인접 리스트로 둔다. 번호 순으로 두므로 아래의 탐색 순서가
		// 행렬을 0..k-1 로 훑는 것과 같아 결과가 같다(행렬 구현과의 비교: TestCheckEpsilonMatchesMatrix).
		n := len(te)
		out := conflictOut(txs, te)
		alive := make([]bool, n)
		for i := range alive {
			alive[i] = true
		}
		dfs := newCycleFinder(out, alive)

		// Algorithm 3: 간선마다, 그 간선을 지나는 고리가 남아 있으면 abort 점수가 가장 작은 것을 버린다
		for r := 0; r < n; r++ {
			for _, c := range out[r] {
				for alive[r] && alive[c] {
					cycle := dfs.find(r, c)
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

		// Algorithm 4: 위상 정렬(간선 방향, 놓을 수 있는 것 중 번호가 가장 작은 것부터) 후 뒤집기.
		// 가장 작은 번호를 고르는 데 힙을 쓴다(행렬 구현은 매번 0..k-1 을 훑었다).
		indeg := make([]int, n)
		for r := 0; r < n; r++ {
			if !alive[r] {
				continue
			}
			for _, c := range out[r] {
				if alive[c] {
					indeg[c]++
				}
			}
		}
		ready := &intHeap{}
		for v := 0; v < n; v++ {
			if alive[v] && indeg[v] == 0 {
				heap.Push(ready, v)
			}
		}
		var sorted []int
		for ready.Len() > 0 {
			next := heap.Pop(ready).(int)
			sorted = append(sorted, next)
			for _, c := range out[next] {
				if alive[c] {
					indeg[c]--
					if indeg[c] == 0 {
						heap.Push(ready, c)
					}
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

// conflictOut builds the conflict graph of te as sorted adjacency lists: out[r] holds every c ≠ r
// whose read set meets the write set of te[r]. 키마다 읽는 쪽 목록을 만들어 O(k·K + E) 에 만든다.
func conflictOut(txs []TxMeta, te []int) [][]int {
	n := len(te)
	readers := make(map[string][]int)
	for c, i := range te {
		for _, key := range txs[i].Reads {
			if l := readers[key]; len(l) == 0 || l[len(l)-1] != c { // 한 tx 가 같은 키를 두 번 읽어도 한 번만
				readers[key] = append(l, c)
			}
		}
	}
	out := make([][]int, n)
	seen := make([]int, n) // seen[c] == r+1 이면 이미 out[r] 에 있다
	for r, i := range te {
		for _, key := range txs[i].Writes {
			for _, c := range readers[key] {
				if c != r && seen[c] != r+1 {
					seen[c] = r + 1
					out[r] = append(out[r], c)
				}
			}
		}
		sort.Ints(out[r])
	}
	return out
}

// cycleFinder finds a cycle through an edge by depth-first search over adjacency lists.
// 방문 표시는 호출마다 지우지 않고 세대 번호로 구분한다. 한 번 찾는 데 O(k + E) 다
// (행렬 구현은 노드마다 k 칸을 훑어 O(k²) 였다).
type cycleFinder struct {
	out     [][]int
	alive   []bool
	visited []int
	gen     int
	path    []int
}

func newCycleFinder(out [][]int, alive []bool) *cycleFinder {
	return &cycleFinder{out: out, alive: alive, visited: make([]int, len(out))}
}

// find returns a cycle through the edge r→c (starting at r), or nil.
// c 에서 출발해 번호 순 깊이 우선 탐색으로 r 로 돌아오는 길을 찾는다.
func (f *cycleFinder) find(r, c int) []int {
	f.gen++
	f.path = append(f.path[:0], r)
	var dfs func(v int) bool
	dfs = func(v int) bool {
		f.visited[v] = f.gen
		f.path = append(f.path, v)
		for _, w := range f.out[v] {
			if !f.alive[w] {
				continue
			}
			if w == r {
				return true
			}
			if f.visited[w] != f.gen && dfs(w) {
				return true
			}
		}
		f.path = f.path[:len(f.path)-1]
		return false
	}
	if dfs(c) {
		return append([]int(nil), f.path...)
	}
	return nil
}

// intHeap is a min-heap of ints (위상 정렬에서 놓을 수 있는 것 중 가장 작은 번호를 고른다).
type intHeap []int

func (h intHeap) Len() int            { return len(h) }
func (h intHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h intHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *intHeap) Push(x interface{}) { *h = append(*h, x.(int)) }
func (h *intHeap) Pop() interface{} {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}
