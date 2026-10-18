package __

import (
	"crypto/sha256"
	"fmt"
	"log"
	"math/big"
	"os"
	"sort"
	"sync"
	"time"
	pb "validator/msg"
	wp2p "validator/wp2p"

	"github.com/herumi/bls-eth-go-binary/bls"
)

type WatchdogCommittee struct {
	ChannelID string
	Members   []pb.Committee
}

type VRFCandidate struct {
	Node *pb.Wnode
	VRF  *big.Int
}

var Watchdogs []WatchdogCommittee

var Slog *log.Logger

var Membership = &pb.MemberMsg{} // *pb.MemberMsg
var RwM = new(sync.RWMutex)      // Membership RW Mutex


type RoundRequest struct {
	Node *pb.Node
	VRF  *big.Int
	// 이 요청을 받은 시각. 오래된 요청은 그 노드가 아직 살아 있다는 근거가 되지 못한다.
	ReceivedAt time.Time
}

// 최소 인원이 찰 때까지 기다리는 동안, 이보다 오래된 등록 요청은 버린다.
// 살아 있는 w-node는 커미티가 정해지지 않으면 20초마다 다시 등록한다.
const requestTTL = 30 * time.Second

// 커미티는 지금 신호를 보내고 있는 노드로만 구성한다. queueLock을 잡고 부른다.
func pruneStaleRequestsLocked(round uint32) {
	fresh := requestQueue[round][:0]
	for _, r := range requestQueue[round] {
		if time.Since(r.ReceivedAt) <= requestTTL {
			fresh = append(fresh, r)
		} else {
			fmt.Printf("Registration of %s expired\n", r.Node.NodeID)
		}
	}
	requestQueue[round] = fresh
}

var (
	requestQueue    = make(map[uint32][]RoundRequest)
	queueLock       sync.Mutex
	roundTimers     = make(map[uint32]*time.Timer)
	roundTimerSet   = make(map[uint32]bool)
	roundCommitted  = make(map[uint32]bool)

	currentRound    uint32 = 0 // 현재 수집 중인 라운드
	roundActive     bool   = false
	// 4개부터 노드 하나의 장애를 견딘다 (n >= 3f+1, f = 1)
	minCommitteeSize       = 4
	maxCommitteeSize       = 20
)


// BLS 연산 전에 꼭 내부 C 포인터 구조 초기화
func Init() {
    bls.Init(bls.BLS12_381)
    bls.SetETHmode(bls.EthModeDraft07)
}

func Start() {
	Init()
	Slog = log.New(os.Stdout, "SLog ", log.LstdFlags)
	Slog.Println("Start")

	Watchdogs = []WatchdogCommittee{}
}

func startCommitteeTimer(round uint32) {
    startedAt := time.Now()
    fmt.Printf("⏱️ timer started round=%d at=%s\n", round, startedAt.Format(time.RFC3339Nano))

    timer := time.AfterFunc(3*time.Second, func() {
        firedAt := time.Now()
        fmt.Printf("🔥 timer fired round=%d at=%s elapsed=%s\n",
            round, firedAt.Format(time.RFC3339Nano), firedAt.Sub(startedAt))

        queueLock.Lock()
        defer queueLock.Unlock()

        if roundCommitted[round] { return }
        if len(requestQueue[round]) == 0 {
            fmt.Printf("⚠️ No nodes received for round %d\n", round)
            roundActive = false
            return
        }
        // 최소 인원에 못 미치면 커미티를 만들지 않는다. 요청은 그대로 두고, 다음 요청이
        // 와서 인원이 차면 타이머를 다시 건다.
        pruneStaleRequestsLocked(round)
        if len(requestQueue[round]) < minCommitteeSize {
            fmt.Printf("⚠️ Only %d node(s) for round %d, waiting for %d\n", len(requestQueue[round]), round, minCommitteeSize)
            delete(roundTimers, round)
            delete(roundTimerSet, round)
            return
        }
        go BuildCommittee(round)
    })
    roundTimers[round] = timer
}



func HandleMembershipRequest(req *pb.MemberMsg) {
	queueLock.Lock()
	defer queueLock.Unlock()

	if !roundActive {
		currentRound = uint32(time.Now().UnixNano() / int64(time.Millisecond))
		roundActive = true
	}

	pruneStaleRequestsLocked(currentRound)

	// 현재 라운드에 이미 등록한 노드의 위치
	existing := make(map[string]int)
	for i, r := range requestQueue[currentRound] {
		existing[r.Node.NodeID] = i
	}

	for _, node := range req.Nodes {

		var pubKey bls.PublicKey
		if err := pubKey.Deserialize(node.Publickey); err != nil {
			fmt.Printf("❌ Node %s public key deserialize failed\n", node.NodeID)
			continue
		}

		vrfVal, ok := VerifyVRF(node.Seed, node.Proof, pubKey)
		if !ok {
			fmt.Printf("❌ Node %s VRF verification failed\n", node.NodeID)
			continue
		}

		request := RoundRequest{Node: node, VRF: vrfVal, ReceivedAt: time.Now()}

		// 다시 등록한 노드는 새 요청으로 바꾼다. 아직 살아 있다는 신호다.
		if i, ok := existing[node.NodeID]; ok {
			requestQueue[currentRound][i] = request
			continue
		}
		requestQueue[currentRound] = append(requestQueue[currentRound], request)
		existing[node.NodeID] = len(requestQueue[currentRound]) - 1
	}

	if len(requestQueue[currentRound]) >= minCommitteeSize && !roundTimerSet[currentRound] {
		startCommitteeTimer(currentRound)
		roundTimerSet[currentRound] = true
	}

	// 커미티를 만든 직후에 그 커미티에 없던 노드가 등록하면(활성 s-node 가 바뀐 뒤 늦게 다시 붙은 노드),
	// 그 노드만으로는 최소 인원에 못 미쳐 다음 라운드까지 남는다. 방금 만든 커미티의 등록과 합쳐 다시 만든다(NOTES §48).
	if n := len(requestQueue[currentRound]); earlyCommittee && n < minCommitteeSize && time.Since(lastBuiltAt) < lateWindow {
		inLast := make(map[string]bool, len(lastBuilt))
		for _, r := range lastBuilt {
			inLast[r.Node.NodeID] = true
		}
		late := false
		for _, r := range requestQueue[currentRound] {
			if !inLast[r.Node.NodeID] {
				late = true
			}
		}
		if late {
			for _, r := range lastBuilt {
				if _, ok := existing[r.Node.NodeID]; !ok {
					requestQueue[currentRound] = append(requestQueue[currentRound], r)
					existing[r.Node.NodeID] = len(requestQueue[currentRound]) - 1
				}
			}
			fmt.Printf("🧩 late registration: merged with the committee built %s ago (%d nodes)\n",
				time.Since(lastBuiltAt).Round(time.Millisecond), len(requestQueue[currentRound]))
		}
	}

	// 연결된 w-node 가 모두 등록했으면 3초를 다 기다리지 않는다(NOTES §48). 등록이 잇따라 오는
	// 중일 수 있으므로 마지막 등록 뒤 earlyQuiet 동안 새 등록이 없을 때 만든다. 3초 타이머는 상한으로 남는다.
	// 활성 s-node 가 바뀐 직후에는 이전 커미티를 모르므로, 지금 연결된 수와 비교한다.
	if n := len(requestQueue[currentRound]); earlyCommittee && n >= minCommitteeSize && n >= wp2p.TopicPeerCount() {
		round := currentRound
		delay := earlyQuiet
		if since := wp2p.SinceReady(); since < earlyGrace {
			delay = earlyGrace - since + earlyQuiet // 다시 붙는 w-node 를 기다린 뒤 판단한다
		}
		if t, ok := earlyTimers[round]; ok {
			t.Stop()
		}
		earlyTimers[round] = time.AfterFunc(delay, func() {
			queueLock.Lock()
			delete(earlyTimers, round)
			ready := !roundCommitted[round] && len(requestQueue[round]) >= minCommitteeSize &&
				len(requestQueue[round]) >= wp2p.TopicPeerCount()
			queueLock.Unlock()
			if ready {
				fmt.Printf("⚡ all %d connected w-nodes registered, building round %d early\n", wp2p.TopicPeerCount(), round)
				BuildCommittee(round)
			}
		})
	}
}

// 연결된 w-node 가 모두 등록한 뒤 커미티를 만들기 전에 기다리는 시간 (뒤이어 오는 등록을 모은다)
const earlyQuiet = 300 * time.Millisecond

// 활성이 된 직후에는 w-node 들이 하나씩 다시 붙는 중이라 "연결된 수"가 아직 작다. 그때 일찍 만들면
// 커미티가 갈라진다(먼저 붙은 노드끼리 만들고 나머지는 최소 인원에 못 미쳐 남는다). 그동안은 3초 타이머를 쓴다.
// w-node 의 연결 확인(1초)과 재접속 대기(1초)가 한 번씩 더 돌 여유다. SNODE_EARLY_GRACE 로 바꿀 수 있다.
var earlyGrace = envDur("SNODE_EARLY_GRACE", 3*time.Second)

func envDur(name string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(os.Getenv(name)); err == nil && d > 0 {
		return d
	}
	return def
}

var earlyTimers = make(map[uint32]*time.Timer)

// 마지막으로 만든 커미티의 등록과 그 시각. 늦게 온 노드를 합칠 때 쓴다.
var (
	lastBuilt   []RoundRequest
	lastBuiltAt time.Time
)

// 커미티를 만든 뒤 이 시간 안에 온, 커미티에 없던 노드는 방금 커미티와 합쳐 다시 만든다
const lateWindow = 5 * time.Second

// SNODE_EARLY_COMMITTEE=0 이면 예전처럼 항상 3초를 기다리고, 늦게 온 노드도 합치지 않는다(전후 비교용)
var earlyCommittee = os.Getenv("SNODE_EARLY_COMMITTEE") != "0"



func BuildCommittee(round uint32) {
	queueLock.Lock()

	if roundCommitted[round] {
		queueLock.Unlock()
		return
	}
	roundCommitted[round] = true
	requests := requestQueue[round]
	delete(requestQueue, round)
	lastBuilt = append([]RoundRequest(nil), requests...)
	lastBuiltAt = time.Now()
	cancelRoundTimer(round)

	// 발행하는 동안 도착하는 요청이 이미 끝난 라운드에 쌓이지 않도록
	// 다음 라운드를 여기서 바로 연다
	currentRound = uint32(time.Now().UnixNano() / int64(time.Millisecond)) // 다음 라운드 번호 갱신
	roundActive = true
	startCommitteeTimer(currentRound)
	roundTimerSet[currentRound] = true
	queueLock.Unlock()

	if len(requests) == 0 {
		fmt.Printf("⚠️ No valid requests for round %d\n", round)
		return
	}

	channels := wp2p.ChannelIDs()
	if len(channels) == 0 {
		fmt.Printf("⚠️ No channel known yet, round %d dropped\n", round)
	}

	for _, channelID := range channels {

		var candidates []RoundRequest
		candidates = append(candidates, requests...)

		sort.Slice(candidates, func(i, j int) bool {
			return candidates[i].VRF.Cmp(candidates[j].VRF) < 0
		})

		limit := len(candidates)
		if limit > maxCommitteeSize {
			limit = maxCommitteeSize
		}

		shardMsg := &pb.Shard{
			ID:       channelID,
			LeaderID: candidates[0].Node.NodeID,
		}

		for i := 0; i < limit; i++ {
			shardMsg.Member = append(shardMsg.Member, &pb.Wnode{
				NodeID:    candidates[i].Node.NodeID,
				Addrs:      candidates[i].Node.Addrs,
				Port:      candidates[i].Node.Port,
				Publickey: candidates[i].Node.Publickey,
				Seed:      candidates[i].Node.Seed,
				Proof:     candidates[i].Node.Proof,
				Value:     candidates[i].Node.Value,
			})
			fmt.Println(candidates[i].Node.NodeID)
		}

		committeeMsg := &pb.CommitteeMsg{
			Type:     1,
			RoundNum: round,
			Shards:   []*pb.Shard{shardMsg},
		}

		wp2p.CommitteeMessage(wp2p.Wctx, wp2p.Wtopic, committeeMsg)
		fmt.Printf("✅ Committee created for round %d and topic %s\n", round, channelID)
	}
}



func VerifyVRF(seed string, proof []byte, pubKey bls.PublicKey) (*big.Int, bool) {
    var sig bls.Sign
    if err := sig.Deserialize(proof); err != nil {
        return nil, false
    }

    seedHash := sha256.Sum256([]byte(seed))
    if !sig.FastAggregateVerify([]bls.PublicKey{pubKey}, seedHash[:]) {
        return nil, false
    }

    sigHash := sha256.Sum256(proof)
    vrfValue := new(big.Int).SetBytes(sigHash[:])

    return vrfValue, true
}

func VRFHash(nodeID, seed string) *big.Int { 
	data := []byte(nodeID + seed) 
	hash := sha256.Sum256(data) 
	return new(big.Int).SetBytes(hash[:]) 
}

func cancelRoundTimer(round uint32) {
	if timer, ok := roundTimers[round]; ok {
		timer.Stop()
		delete(roundTimers, round)
	}
	delete(roundTimerSet, round)
}

