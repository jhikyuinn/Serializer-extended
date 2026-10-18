package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"

	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"google.golang.org/protobuf/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/examples/data"

	"validator/cluster"
	msp "validator/membership"
	pb "validator/msg"
	wp2p "validator/wp2p"
)

type Validator struct {
    IP string `json:"ip"`
}

type server struct {
	pb.UnimplementedMembershipServiceServer
}

type NodeMeta struct {
	LastSeen time.Time
}

const nodeTimeout = 10 * time.Second

var NodeMetaMap = make(map[string]*NodeMeta)

var myAddr string

func GetExternalIP() {
	l, err := net.Listen("tcp", myAddr+":11730")
	if nil != err {
		log.Println(err)
	}
	defer l.Close()

	for {
		conn, err := l.Accept()
		if err != nil {
            log.Println("Accept error:", err)
            continue
        }
		go ConnHandler(conn)
	}
}

func ConnHandler(conn net.Conn) {
	defer conn.Close()

	recvBuf := make([]byte, 64)
	n, err := conn.Read(recvBuf)
	if err != nil {
		if err == io.EOF {
            log.Printf("Connection closed by client: %v", conn.RemoteAddr())
        } else {
            log.Printf("Failed to read data: %v", err)
        }
		return
	}
	var id string
    if err := json.Unmarshal(recvBuf[:n], &id); err != nil {
        log.Printf("JSON unmarshal error: %v", err)
        return
    }

	fmt.Println("Connected NODE_ID:", id)

	msp.RwM.Lock()
	defer msp.RwM.Unlock()

	for idx, each := range msp.Membership.Nodes {
		if each.NodeID == id {
			fmt.Println(each.Addrs)
            ip, _, err := net.SplitHostPort(conn.RemoteAddr().String())
            if err != nil {
                log.Println("Failed to parse remote address:", err)
                return
            }
			fmt.Println(idx,ip)
            // msp.Membership.Nodes[idx].Addrs = ip
            break
        }
	}
}

func UpdateNode(node *pb.Node) {
	now := time.Now()
	msp.RwM.Lock()
	defer msp.RwM.Unlock()

	for i := range msp.Membership.Nodes {
		if msp.Membership.Nodes[i].NodeID == node.NodeID {
			msp.Membership.Nodes[i] = node

			if meta, ok := NodeMetaMap[node.NodeID]; ok {
				meta.LastSeen = now
			} else {
				NodeMetaMap[node.NodeID] = &NodeMeta{LastSeen: now}
			}
			return
		}
	}

	msp.Membership.Nodes = append(msp.Membership.Nodes, node)
	NodeMetaMap[node.NodeID] = &NodeMeta{LastSeen: now}
	fmt.Println("🆕 Add new node:", node.NodeID)
}

func IsNodeAlive(nodeID string) bool {
	msp.RwM.RLock()
    meta, ok := NodeMetaMap[nodeID]
    msp.RwM.RUnlock()

    if !ok {
        return false
    }
    return time.Since(meta.LastSeen) <= nodeTimeout
}

func RemoveDeadNodes() {
	ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

	for range ticker.C {
        now := time.Now()

        msp.RwM.Lock()
        alive := msp.Membership.Nodes[:0] 
        for _, node := range msp.Membership.Nodes {
            meta, ok := NodeMetaMap[node.NodeID]
            if ok && now.Sub(meta.LastSeen) <= nodeTimeout {
                alive = append(alive, node)
            } else {
                fmt.Println("🗑️ Removing inactive node:", node.NodeID)
                delete(NodeMetaMap, node.NodeID)
            }
        }
        msp.Membership.Nodes = alive
        msp.RwM.Unlock()
    }
}

// GRPC SERVICE
func (s *server) GetMembership(ctx context.Context, msg *pb.MemberMsg) (*pb.MemberMsg, error) {
	// 대기 중인 pod에는 w-node가 연결되어 있지 않으므로 여기서 커미티를 만들면 안 된다
	if !cluster.IsActive() {
		return nil, status.Error(codes.Unavailable, "standby s-node")
	}
	if len(msg.Nodes) == 0 {
		return nil, errors.New("no node information received")
	}

	node := msg.Nodes[0]
	UpdateNode(node)
	fmt.Println("MSG INFO",msg.Nodes[0].Publickey)

	msp.HandleMembershipRequest(msg)

	log.Printf("GetMembership called nodes=%d", len(msg.Nodes))
	defer log.Printf("GetMembership returning")

	msp.RwM.RLock()
	snap := proto.Clone(msp.Membership).(*pb.MemberMsg)
	defer msp.RwM.RUnlock()
	return snap, nil
}

func main() {
	validatorAddr := flag.String("validator", "127.0.0.1", "Validator IP address")
    kafkaprocessorAddr := flag.String("kafkaprocessor", "127.0.0.1", "Kafka processor IP")
    tls := flag.Bool("tls", false, "Use TLS for gRPC")
    certFile := flag.String("cert_file", "", "TLS cert file")
    keyFile := flag.String("key_file", "", "TLS key file")
	brokersFlag := flag.String("brokers", "", "Kafka bootstrap servers (default: <kafkaprocessor>:9091,9092,9093)")
	standalone := flag.Bool("standalone", false, "Run as the only s-node, without a Kubernetes Lease")
	replication := flag.Int("replication", 3, "Replication factor of the key topic")
	statusAddr := flag.String("status", ":8080", "HTTP address for /healthz, /readyz and /status")
	flag.Parse()

	validator := Validator{IP: *validatorAddr}
    log.Println("Host IP:", validator.IP)

	brokers := *brokersFlag
	if brokers == "" {
		brokers = *kafkaprocessorAddr + ":9091," + *kafkaprocessorAddr + ":9092," + *kafkaprocessorAddr + ":9093"
	}
	wp2p.SetBrokers(brokers)

	// 대기 pod도 키를 미리 읽어 두어 인계 시간을 줄인다
	if err := wp2p.EnsureKeyTopic(*replication); err != nil {
		log.Fatalf("failed to prepare the key topic: %v", err)
	}
	if err := wp2p.PreloadKey(*kafkaprocessorAddr); err != nil {
		log.Fatalf("failed to load the s-node key: %v", err)
	}

	go RemoveDeadNodes()

	// Membership processor
	msp.Start()

	// TCP listener for updating external IPs
	lis, err := net.Listen("tcp", myAddr+":16220")
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}
	go GetExternalIP()

	// --- gRPC server ---
	var opts []grpc.ServerOption
	if *tls {
		if *certFile == "" {
			*certFile = data.Path("x509/server_cert.pem")
		}
		if *keyFile == "" {
			*keyFile = data.Path("x509/server_key.pem")
		}
		creds, err := credentials.NewServerTLSFromFile(*certFile, *keyFile)
		if err != nil {
			log.Fatalf("Failed to generate credentials %v", err)
		}
		opts = []grpc.ServerOption{grpc.Creds(creds)}
	}
	grpcServer := grpc.NewServer(opts...)
	pb.RegisterMembershipServiceServer(grpcServer, &server{})
	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("gRPC server failed: %v", err)
		}
	}()

	ready.Store(true)
	go serveStatus(*statusAddr)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	podName := os.Getenv("POD_NAME")
	if podName == "" {
		podName, _ = os.Hostname()
	}

	if *standalone || !cluster.Available() {
		log.Println("No Kubernetes Lease in use: running as the only s-node")
		cluster.RunStandalone(podName)
		if err := startPubsub(kafkaprocessorAddr); err != nil {
			log.Fatal(err)
		}
		<-ctx.Done()
	} else {
		err := cluster.Run(ctx, cluster.Config{
			Namespace:     os.Getenv("POD_NAMESPACE"),
			PodName:       podName,
			LeaseName:     "snode-active",
			PodSelector:   "app=snode",
			RoleLabel:     "snode-role",
			// 활성 pod 가 멈추면 LeaseDuration 이 지나야 다른 pod 가 이어받는다. 6/4/1 초에서 줄였다(NOTES §48).
			// 너무 짧으면 API 서버가 잠깐 느릴 때도 활성이 바뀐다. 환경 변수로 바꿀 수 있다.
			LeaseDuration: envDuration("SNODE_LEASE_DURATION", 2*time.Second),
			RenewDeadline: envDuration("SNODE_RENEW_DEADLINE", 1500*time.Millisecond),
			RetryPeriod:   envDuration("SNODE_RETRY_PERIOD", 500*time.Millisecond),
		}, func() error { return startPubsub(kafkaprocessorAddr) })
		if err != nil {
			// 활성 자격을 잃으면 연결된 w-node가 새 활성 pod로 옮겨 가도록 프로세스를 끝낸다
			log.Fatalf("s-node stopped: %v", err)
		}
	}

	log.Println("Shutting down")
	grpcServer.GracefulStop()
}

// startPubsub opens the libp2p network and returns once w-nodes can connect.
func startPubsub(kafkaprocessorAddr *string) error {
	wps := wp2p.WatchdogPubsub{}
	go wps.Start(kafkaprocessorAddr)

	deadline := time.Now().Add(60 * time.Second)
	for !wp2p.Ready() {
		if time.Now().After(deadline) {
			return errors.New("pubsub did not become ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil
}

var ready atomic.Bool

func serveStatus(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	// 대기 pod도 정상이면 Ready다. 트래픽은 Service가 snode-role=active 라벨로 고른다.
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if !ready.Load() {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		msp.RwM.RLock()
		members := len(msp.Membership.Nodes)
		msp.RwM.RUnlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"pod":      cluster.PodID(),
			"lease":    cluster.Enabled(),
			"active":   cluster.IsActive(),
			"peerId":   wp2p.PeerID(),
			"peers":    wp2p.PeerCount(),
			"channels": wp2p.ChannelIDs(),
			"members":  members,
		})
	})
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Printf("status server stopped: %v", err)
	}
}

// envDuration reads a duration such as "2s" or "500ms" from the environment, or returns def.
func envDuration(name string, def time.Duration) time.Duration {
	if v := os.Getenv(name); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
		log.Printf("%s=%q is not a duration, using %s", name, v, def)
	}
	return def
}
