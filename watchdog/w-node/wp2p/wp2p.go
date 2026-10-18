package __

import (
	"bufio"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/libp2p/go-libp2p/p2p/net/swarm"
	"github.com/libp2p/go-libp2p/p2p/protocol/ping"

	pubsub "github.com/libp2p/go-libp2p-pubsub"
	"github.com/multiformats/go-multiaddr"
)

var Wctx context.Context
var Wtopic *pubsub.Topic

var Shard []*pubsub.Topic

var ps *pubsub.PubSub

var Host string

// discoveryNotifee gets notified when we find a new peer via mDNS discovery
type discoveryNotifee struct {
	h host.Host
}

func Start(isLeader bool, dest string, sourcePort int) {

	ctx, _ := context.WithCancel(context.Background())
	Wctx = ctx

	r := rand.Reader

	// create a new libp2p Host that listens on a TCP port

	hotty, err := makeHost(sourcePort, r)
	if err != nil {
		panic(err)
	}
	Host = hotty.ID().String()

	fmt.Printf("Peer ID: %s\n", hotty.ID())

	_, err = startPeerAndConnect(hotty, dest)
	if err != nil {
		log.Println(err)
	}
	go keepConnected(ctx, hotty, dest)

	// create a new PubSub service using the GossipSub router
	ps, err = pubsub.NewGossipSub(ctx, hotty)
	if err != nil {
		panic(err)
	}

	// setup local mDNS discovery
	if err := setupDiscovery(hotty); err != nil {
		panic(err)
	}

	topic, err := JoinNetwork(ctx, ps, "watchdog/group/w-node", 1)
	if err != nil {
		panic(err)
	}

	Wtopic = topic
}

func makeHost(port int, randomness io.Reader) (host.Host, error) {
	// Creates a new RSA key pair for this host.
	prvKey, _, err := crypto.GenerateKeyPairWithReader(crypto.RSA, 2048, randomness)
	if err != nil {
		log.Println(err)
		return nil, err
	}

	// 0.0.0.0 will listen on any interface device.
	sourceMultiAddr, _ := multiaddr.NewMultiaddr(fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port))

	// libp2p.New constructs a new libp2p Host.
	// Other options can be added here.
	return libp2p.New(
		libp2p.ListenAddrs(sourceMultiAddr),
		libp2p.Identity(prvKey),
	)
}

func startPeerAndConnect(h host.Host, destination string) (*bufio.ReadWriter, error) {
	log.Println("This node's multiaddresses:")
	for _, la := range h.Addrs() {
		log.Printf(" - %v\n", la)
	}
	log.Println()

	// Turn the destination into a multiaddr.
	maddr, err := multiaddr.NewMultiaddr(destination)
	if err != nil {
		log.Println(err)
		return nil, err
	}

	// Extract the peer ID from the multiaddr.
	info, err := peer.AddrInfoFromP2pAddr(maddr)
	if err != nil {
		log.Println(err)
		return nil, err
	}

	// Add the destination's peer multiaddress in the peerstore.
	// This will be used during connection and stream creation by libp2p.
	h.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)

	// Start a stream with the destination.
	// Multiaddress of the destination peer is fetched from the peerstore using 'peerId'.
	s, err := h.NewStream(context.Background(), info.ID, "/chat/1.0.0")
	if err != nil {
		log.Println(err)
		return nil, err
	}
	log.Println("Established connection to destination")

	// Create a buffered stream so that read and writes are non-blocking.
	rw := bufio.NewReadWriter(bufio.NewReader(s), bufio.NewWriter(s))

	return rw, nil
}

// SnodeCheckInterval is how often the s-node connection is pinged (and redialed when gone);
// a ping that takes longer than this counts as no answer. 3초에서 1초로 줄였다(Serializer NOTES §48).
var SnodeCheckInterval = time.Second

// SnodeDialTimeout bounds one redial of the s-node. 활성 pod 가 바뀌는 동안 Service 너머의 연결이 응답 없이
// 걸려 있을 수 있어, 5초로 두면 w-node 들이 5초 간격의 두 무리로 나뉘어 다시 붙고 커미티가 갈라졌다(NOTES §48).
// 지역이 떨어진 배포처럼 왕복이 길면 늘린다(-snodedial).
var SnodeDialTimeout = time.Second

// keepConnected redials the s-node whenever the connection is gone. The s-node
// address always leads to the currently active pod, so a redial reaches the
// one that took over.
func keepConnected(ctx context.Context, h host.Host, destination string) {
	maddr, err := multiaddr.NewMultiaddr(destination)
	if err != nil {
		return
	}
	info, err := peer.AddrInfoFromP2pAddr(maddr)
	if err != nil {
		return
	}

	// The connection can also come back because the s-node dialed us, so the
	// re-registration hangs on the connection itself, not on our redial.
	var lost atomic.Bool
	h.Network().Notify(&network.NotifyBundle{
		DisconnectedF: func(n network.Network, c network.Conn) {
			if c.RemotePeer() == info.ID && n.Connectedness(info.ID) != network.Connected {
				lost.Store(true)
			}
		},
		ConnectedF: func(_ network.Network, c network.Conn) {
			if c.RemotePeer() != info.ID || !lost.Swap(false) {
				return
			}
			log.Println("Reconnected to s-node")

			// The newly active s-node starts with no membership state.
			reconnectMu.Lock()
			cb := onReconnect
			reconnectMu.Unlock()
			if cb != nil {
				go cb()
			}
		},
	})

	ticker := time.NewTicker(SnodeCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		if h.Network().Connectedness(info.ID) == network.Connected {
			// A pod that died with its node leaves the connection half open;
			// do not wait for the transport's own keepalive to notice.
			pingCtx, cancel := context.WithTimeout(ctx, SnodeCheckInterval)
			// On a timeout the channel is closed without a result.
			res, answered := <-ping.Ping(pingCtx, h, info.ID)
			cancel()
			if answered && res.Error == nil {
				continue
			}
			if !answered {
				res.Error = context.DeadlineExceeded
			}
			log.Println("s-node does not answer, dropping the connection:", res.Error)
			h.Network().ClosePeer(info.ID)
		}

		// s-node pod 들은 같은 peer ID 를 쓴다. identify 로 배운 예전 pod 의 내부 주소(10.244.x.x 등)가
		// 주소록에 남아 있으면 그쪽으로 다이얼하다 시간 초과까지 걸린다(NOTES §48). 설정된 주소만 남긴다.
		h.Peerstore().ClearAddrs(info.ID)
		h.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.PermanentAddrTTL)
		// 한 번 실패하면 libp2p 가 약 5초 동안 그 peer 로 다이얼하지 않는다(dial backoff). 우리가 정한 주기대로
		// 다시 시도해야 새 활성 pod 에 바로 붙는다.
		if sw, ok := h.Network().(*swarm.Swarm); ok {
			sw.Backoff().Clear(info.ID)
		}
		dialCtx, cancel := context.WithTimeout(ctx, SnodeDialTimeout)
		err := h.Connect(dialCtx, *info)
		cancel()
		if err != nil {
			log.Println("Reconnecting to s-node failed:", err)
		}
	}
}

var (
	reconnectMu sync.Mutex
	onReconnect func()
)

// SetOnReconnect registers what to do after the s-node connection is restored.
func SetOnReconnect(f func()) {
	reconnectMu.Lock()
	onReconnect = f
	reconnectMu.Unlock()
}

func JoinShard(channel string) {
	ctx, _ := context.WithCancel(context.Background())

	topic, err := JoinNetwork(ctx, ps, "watchdog/"+channel, 2)
	if err != nil {
		fmt.Println("FAILED")
		fmt.Println(err)
		return
	}

	// Shard = topic
	Shard = append(Shard, topic)
	for _, s := range Shard {
		fmt.Println(s)
	}
}
