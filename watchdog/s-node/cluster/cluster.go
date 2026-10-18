// Package cluster keeps exactly one of several s-node pods active.
//
// Every pod competes for a Kubernetes Lease. The holder is the active s-node:
// it opens the libp2p network and labels its own pod so that the Service sends
// all w-node traffic to it. The others stay on standby and take over when the
// holder stops renewing the Lease.
package cluster

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync/atomic"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

const (
	RoleActive  = "active"
	RoleStandby = "standby"
)

type Config struct {
	Namespace string
	PodName   string
	LeaseName string
	// PodSelector matches every s-node pod, e.g. "app=snode".
	PodSelector string
	// RoleLabel is the pod label the Service selects the active pod by.
	RoleLabel string

	LeaseDuration time.Duration
	RenewDeadline time.Duration
	RetryPeriod   time.Duration
}

var (
	podName string
	enabled atomic.Bool
	active  atomic.Bool
)

func Enabled() bool  { return enabled.Load() }
func IsActive() bool { return active.Load() }
func PodID() string  { return podName }

// Available reports whether a Kubernetes API is reachable from this process.
func Available() bool {
	if os.Getenv("KUBECONFIG") != "" {
		return true
	}
	_, err := rest.InClusterConfig()
	return err == nil
}

// RunStandalone marks this process as the only s-node.
func RunStandalone(name string) {
	podName = name
	active.Store(true)
}

// Run blocks until ctx is cancelled or the Lease is lost. start is called once
// this pod holds the Lease and must return when the pod can serve w-nodes.
func Run(ctx context.Context, cfg Config, start func() error) error {
	podName = cfg.PodName

	restCfg, err := restConfig()
	if err != nil {
		return err
	}
	client, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return err
	}
	enabled.Store(true)

	// A restarted container keeps its pod labels; never start as active.
	if err := setRole(client, cfg, cfg.PodName, RoleStandby); err != nil {
		return fmt.Errorf("label pod as standby: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	lost := make(chan error, 1)
	fail := func(err error) {
		select {
		case lost <- err:
		default:
		}
		cancel()
	}

	leaderelection.RunOrDie(runCtx, leaderelection.LeaderElectionConfig{
		Lock: &resourcelock.LeaseLock{
			LeaseMeta:  metav1.ObjectMeta{Name: cfg.LeaseName, Namespace: cfg.Namespace},
			Client:     client.CoordinationV1(),
			LockConfig: resourcelock.ResourceLockConfig{Identity: cfg.PodName},
		},
		// Hand the Lease over immediately on a clean shutdown.
		ReleaseOnCancel: true,
		LeaseDuration:   cfg.LeaseDuration,
		RenewDeadline:   cfg.RenewDeadline,
		RetryPeriod:     cfg.RetryPeriod,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(context.Context) {
				log.Printf("[cluster] %s acquired the lease", cfg.PodName)
				if err := start(); err != nil {
					fail(fmt.Errorf("start as active: %w", err))
					return
				}
				active.Store(true)
				if err := activate(client, cfg); err != nil {
					fail(fmt.Errorf("label pod as active: %w", err))
					return
				}
				log.Printf("[cluster] %s is now the active s-node", cfg.PodName)
			},
			OnStoppedLeading: func() {
				active.Store(false)
				if runCtx.Err() == nil {
					fail(fmt.Errorf("lease lost"))
				}
			},
			OnNewLeader: func(id string) {
				if id != cfg.PodName {
					log.Printf("[cluster] active s-node is %s, %s on standby", id, cfg.PodName)
				}
			},
		},
	})

	active.Store(false)
	// Best effort: stop receiving traffic before the process goes away.
	if err := setRole(client, cfg, cfg.PodName, RoleStandby); err != nil {
		log.Printf("[cluster] label pod as standby: %v", err)
	}

	select {
	case err := <-lost:
		return err
	default:
		return nil
	}
}

func restConfig() (*rest.Config, error) {
	if kubeconfig := os.Getenv("KUBECONFIG"); kubeconfig != "" {
		return clientcmd.BuildConfigFromFlags("", kubeconfig)
	}
	return rest.InClusterConfig()
}

// activate points the Service at this pod only. A previous holder that died
// with its node may still carry the active label.
func activate(client kubernetes.Interface, cfg Config) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	stale, err := client.CoreV1().Pods(cfg.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: cfg.PodSelector + "," + cfg.RoleLabel + "=" + RoleActive,
	})
	if err != nil {
		return err
	}
	for _, p := range stale.Items {
		if p.Name == cfg.PodName {
			continue
		}
		if err := setRole(client, cfg, p.Name, RoleStandby); err != nil {
			return err
		}
	}
	return setRole(client, cfg, cfg.PodName, RoleActive)
}

func setRole(client kubernetes.Interface, cfg Config, pod, role string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	patch := fmt.Sprintf(`{"metadata":{"labels":{%q:%q}}}`, cfg.RoleLabel, role)
	_, err := client.CoreV1().Pods(cfg.Namespace).Patch(ctx, pod, types.MergePatchType, []byte(patch), metav1.PatchOptions{})
	return err
}
