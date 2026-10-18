package main

import (
	"fmt"
	"sort"
)

// Fabric++ (Sharma et al., "Blurring the Lines between Blockchains and Database Systems:
// the Case of Hyperledger Fabric", SIGMOD 2019)의 오더링 단계.
// 비교 실험에서 Kafka 경로와 사용자 통계 기록은 Serializer와 같고, 순서를 정하는 부분만 다르다.
//
// 오더링 단계의 조기 abort (5.2.2절)
//   한 블록 안에서 같은 키를 읽은 트랜잭션은 같은 버전을 읽었어야 한다. 버전이 어긋나면
//   "뒤의 트랜잭션"을 버린다. 논문 문구대로 들어온 순서에서 그 키를 처음 읽은 트랜잭션의
//   버전을 기준으로 삼는다. 여기서 버린 것은 재정렬 대상에서 빠진다.
//
// 재정렬 (5.1절, Algorithm 1)
//   1. 충돌 그래프: Ti가 쓴 키를 Tj가 읽으면 Ti → Tj (Tj가 Ti보다 앞에 와야 한다).
//   2. Tarjan으로 강한 연결 요소(SCC)를 나누고, 노드가 둘 이상인 SCC에서 모든 단순 고리를 찾는다.
//   3. 트랜잭션마다 몇 개의 고리에 들어 있는지 센다.
//   4. 가장 많은 고리에 든 트랜잭션부터 버리고 그 고리를 지운다. 고리가 남지 않을 때까지 반복한다.
//      동률이면 번호가 작은 것을 버린다.
//   5. 남은 그래프에서 source를 찾아 위로 올라가고, 거기서 아래로 내려가며 순서를 쌓은 뒤 뒤집는다.
//
// 논문에 없는 것: 고리 수는 SCC 크기에 대해 지수적으로 늘 수 있다(같은 핫키를 읽고 쓰는
// 트랜잭션 k개). 논문(HTFabric 논문의 재현 실험 포함)에서도 이런 부하에서는 Fabric++가 시간
// 초과로 결과를 내지 못했다. 고리 나열은 논문처럼 Johnson 알고리즘이지만, 프로세서가 멈추지 않도록
// 찾는 고리 수에 상한(fabricppMaxCycles 개, 시작점마다 나눔)을 두었다. 상한에 걸리면 그때까지 찾은
// 고리에 4단계를 적용한 뒤 SCC를 다시 구한다(고리를 하나도 못 찾았으면 SCC 안에서 간선이 가장 많은
// 것을 버린다). 상한에 걸린 횟수는 배치마다 로그로 남긴다.
//
// 논문에 있지만 여기서는 하지 않는 것: 시뮬레이션 단계의 조기 abort(5.2.1절, 피어 수정이 필요),
// 키 수 기준의 배치 자르기(5.1.2절, 오더러 수정이 필요).

const fabricppMaxCycles = 20000

func scheduleFabricPP(txs []TxMeta, _ map[string]*UserStat) (order []int, aborted []int) {
	n := len(txs)
	alive := make([]bool, n)
	for i := range alive {
		alive[i] = true
	}

	// 오더링 단계의 조기 abort
	firstSeen := make(map[string]Version)
	for i, tx := range txs {
		stale := false
		for k, key := range tx.Reads {
			if v, ok := firstSeen[key]; ok && v != tx.ReadVers[k] {
				stale = true
			}
		}
		if stale {
			alive[i] = false
			aborted = append(aborted, i)
			continue
		}
		for k, key := range tx.Reads {
			if _, ok := firstSeen[key]; !ok {
				firstSeen[key] = tx.ReadVers[k]
			}
		}
	}
	early := len(aborted)

	// 1~4. 고리 제거. after[i]는 i가 읽은 키를 쓰는 트랜잭션들이다(논문의 간선을 뒤집은 방향).
	// 고리는 방향과 무관하게 같다.
	after := conflictGraph(txs)
	truncated := 0
	for {
		groups := cyclicGroups(after, alive)
		if len(groups) == 0 {
			break
		}
		var cycles [][]int
		cut := false
		for _, group := range groups {
			c, t := simpleCycles(group, after, alive)
			cycles = append(cycles, c...)
			cut = cut || t
		}
		if cut {
			truncated++
			if len(cycles) == 0 {
				// 상한 안에 고리를 하나도 찾지 못했다. SCC 안에서 간선이 가장 많은 것을 버린다.
				v := busiest(groups, after, alive)
				alive[v] = false
				aborted = append(aborted, v)
				continue
			}
		}
		// 찾은 고리가 모두 없어질 때까지 탐욕적으로 버린다. 상한에 걸렸던 경우에는 남은 고리가
		// 있을 수 있으므로 위로 돌아가 SCC를 다시 구한다.
		aborted = append(aborted, removeCycles(cycles, n, alive)...)
	}

	// 5. 순서 만들기
	order = fabricppSchedule(after, alive)

	fmt.Printf("[Fabric++] early abort %d, cycle abort %d, truncated %d\n", early, len(aborted)-early, truncated)
	return order, aborted
}

// fabricppSchedule is step 5 of Algorithm 1. 논문 그래프에서 v의 부모는 v가 읽은 키를 쓰는
// 트랜잭션(after[v])이고, 자식은 v가 쓴 키를 읽는 트랜잭션이다. 부모가 모두 놓인 노드만 놓으므로
// 쌓인 순서는 쓰는 쪽이 앞이다. 마지막에 뒤집어 읽는 쪽이 앞에 오게 한다.
func fabricppSchedule(after [][]int, alive []bool) []int {
	n := len(after)
	parents := make([][]int, n)
	children := make([][]int, n)
	for v := 0; v < n; v++ {
		if !alive[v] {
			continue
		}
		for _, w := range after[v] {
			if alive[w] {
				parents[v] = append(parents[v], w)
				children[w] = append(children[w], v)
			}
		}
	}
	for v := 0; v < n; v++ {
		sort.Ints(parents[v])
		sort.Ints(children[v])
	}

	total := 0
	for v := 0; v < n; v++ {
		if alive[v] {
			total++
		}
	}
	scheduled := make([]bool, n)
	nextNode := func() int { // 아직 놓이지 않은 것 중 번호가 가장 작은 것
		for v := 0; v < n; v++ {
			if alive[v] && !scheduled[v] {
				return v
			}
		}
		return -1
	}

	order := make([]int, 0, total)
	start := nextNode()
	for len(order) < total {
		if scheduled[start] {
			start = nextNode()
			continue
		}
		add := true
		for _, p := range parents[start] { // 위로 올라가 source를 찾는다
			if !scheduled[p] {
				start = p
				add = false
				break
			}
		}
		if add { // source를 놓고 아래로 내려간다
			scheduled[start] = true
			order = append(order, start)
			for _, c := range children[start] {
				if !scheduled[c] {
					start = c
					break
				}
			}
		}
	}

	for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
		order[i], order[j] = order[j], order[i]
	}
	return order
}

// simpleCycles lists the elementary cycles inside one SCC with Johnson's algorithm
// (D. B. Johnson, "Finding All the Elementary Circuits of a Directed Graph", SIAM J. Comput. 1975),
// 논문 Algorithm 1 의 getAllCycles 와 같다. 시간은 O((n + E)(C + 1)) 이다.
//
// 시작점 s 를 번호 순으로 고르고, "s 이상인 노드만 남긴 그래프"에서 s 가 속한 강한 연결 요소 안에서만
// s 로 돌아오는 고리를 찾는다. 막힌(blocked) 노드는 s 로 돌아갈 길이 생길 때까지 다시 들어가지 않으므로,
// 고리를 하나도 만들지 못하는 탐색을 되풀이하지 않는다. 각 고리는 가장 작은 번호에서 시작하는 것 하나로만 센다.
//
// 상한(논문에 없음): 핫키에 몰린 트랜잭션은 고리 수 C 자체가 지수적으로 많아 끝나지 않는다. 시작점마다
// 고리 fabricppMaxCycles/노드 수 개까지만 찾는다(한 시작점이 다 쓰면 찾은 고리가 모두 그것을 지나가
// 4단계가 한 번에 하나만 버리게 되기 때문에 나눠 준다). Johnson 에서는 탐색 한 단계가 고리 하나로
// 이어지므로 단계 상한은 따로 두지 않아도 고리 상한으로 시간이 묶인다.
func simpleCycles(group []int, after [][]int, alive []bool) (cycles [][]int, truncated bool) {
	inGroup := make(map[int]bool, len(group))
	for _, v := range group {
		inGroup[v] = true
	}
	nodes := append([]int(nil), group...)
	sort.Ints(nodes)

	cycleBudget := fabricppMaxCycles / len(nodes)
	if cycleBudget < 1 {
		cycleBudget = 1
	}

	n := len(after)
	sub := make([]bool, n) // 이번 시작점에서 볼 노드: s 이상, 같은 강한 연결 요소
	blocked := make([]bool, n)
	bset := make([]map[int]bool, n) // Johnson 의 B(v): v 가 풀리면 함께 풀 노드
	var stack []int
	var s, found int
	stop := false

	var unblock func(u int)
	unblock = func(u int) {
		blocked[u] = false
		for w := range bset[u] {
			delete(bset[u], w)
			if blocked[w] {
				unblock(w)
			}
		}
	}

	var circuit func(v int) bool
	circuit = func(v int) bool {
		f := false
		stack = append(stack, v)
		blocked[v] = true
		for _, w := range after[v] {
			if stop {
				break
			}
			if !sub[w] {
				continue
			}
			if w == s {
				cycles = append(cycles, append([]int(nil), stack...))
				f = true
				found++
				if found >= cycleBudget {
					stop = true
				}
			} else if !blocked[w] && circuit(w) {
				f = true
			}
		}
		if f || stop {
			unblock(v)
		} else {
			for _, w := range after[v] {
				if sub[w] {
					if bset[w] == nil {
						bset[w] = make(map[int]bool)
					}
					bset[w][v] = true
				}
			}
		}
		stack = stack[:len(stack)-1]
		return f
	}

	for _, start := range nodes {
		// s 이상인 노드만 남긴 그래프에서 start 가 속한 강한 연결 요소
		mask := make([]bool, n)
		for _, v := range nodes {
			mask[v] = alive[v] && v >= start
		}
		var comp []int
		for _, g := range cyclicGroups(after, mask) {
			for _, v := range g {
				if v == start {
					comp = g
					break
				}
			}
			if comp != nil {
				break
			}
		}
		if comp == nil {
			continue // start 를 지나는 고리가 없다
		}
		for i := range sub {
			sub[i] = false
		}
		for _, v := range comp {
			sub[v] = true
			blocked[v] = false
			bset[v] = nil
		}
		s, found, stop, stack = start, 0, false, stack[:0]
		circuit(start)
		if stop {
			truncated = true
		}
	}
	return cycles, truncated
}

// removeCycles is steps 3 and 4 of Algorithm 1: count for each transaction the cycles it is in,
// then repeatedly abort the one in the most cycles (동률이면 번호가 작은 것) and drop those cycles,
// decrementing the counts of their other members, until no cycle is left.
func removeCycles(cycles [][]int, n int, alive []bool) (aborted []int) {
	count := make([]int, n)
	cyclesOf := make([][]int, n)
	for ci, c := range cycles {
		for _, v := range c {
			count[v]++
			cyclesOf[v] = append(cyclesOf[v], ci)
		}
	}
	gone := make([]bool, len(cycles))
	for left := len(cycles); left > 0; {
		best := -1
		for v := 0; v < n; v++ {
			if count[v] > 0 && (best == -1 || count[v] > count[best]) {
				best = v
			}
		}
		alive[best] = false
		aborted = append(aborted, best)
		for _, ci := range cyclesOf[best] {
			if gone[ci] {
				continue
			}
			gone[ci] = true
			left--
			for _, v := range cycles[ci] {
				count[v]--
			}
		}
	}
	return aborted
}

// busiest returns the transaction with the most in- and out-edges inside its SCC
// (동률이면 번호가 작은 것). 고리 나열이 상한에 걸려 고리를 하나도 못 찾았을 때만 쓴다.
func busiest(groups [][]int, after [][]int, alive []bool) int {
	best, bestDeg := -1, -1
	for _, group := range groups {
		inGroup := make(map[int]bool, len(group))
		for _, v := range group {
			inGroup[v] = true
		}
		deg := make(map[int]int, len(group))
		for _, v := range group {
			for _, w := range after[v] {
				if alive[w] && inGroup[w] {
					deg[v]++
					deg[w]++
				}
			}
		}
		for _, v := range group {
			if deg[v] > bestDeg || (deg[v] == bestDeg && v < best) {
				best, bestDeg = v, deg[v]
			}
		}
	}
	return best
}

