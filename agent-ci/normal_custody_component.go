package main

// Explicit test-only Collector adapter. Factory construction is inert; owner
// effects begin only at Start. Not registered in raw/default Collector factories.
import (
	"context"
	"sync"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componentstatus"
	"go.opentelemetry.io/collector/extension"
)

var normalComponentType = component.MustNewType("monitoring_normal_custody_test")

type normalComponentConfig struct {
	ResumeMode string `mapstructure:"graceful_resume"`
	Mode       string `mapstructure:"mode"`
	Endpoint   string `mapstructure:"endpoint"`
	Directory  string `mapstructure:"directory"`
	Backend    string `mapstructure:"backend"`
	APIKey     string `mapstructure:"api_key"`
}

func (c *normalComponentConfig) ownerConfig() normalListenerConfig {
	return normalListenerConfig{Mode: c.Mode, Endpoint: c.Endpoint, StateDir: c.Directory, Backend: c.Backend, APIKey: c.APIKey, ResumeMode: c.ResumeMode}
}
func (c *normalComponentConfig) Validate() error { return c.ownerConfig().validate() }

type normalComponentOwner interface {
	start(context.Context) error
	stop(context.Context) error
}
type normalComponent struct {
	mu                sync.Mutex
	owner             normalComponentOwner
	done              <-chan struct{}
	result            func() error
	cancel            context.CancelFunc
	started, stopping bool
	watcherDone       chan struct{}
}

func newNormalComponentFactory() extension.Factory {
	return extension.NewFactory(normalComponentType, func() component.Config { return &normalComponentConfig{} },
		func(_ context.Context, _ extension.Settings, cfg component.Config) (extension.Extension, error) {
			c, ok := cfg.(*normalComponentConfig)
			if !ok || c == nil {
				return nil, normalInvalid
			}
			a, e := newNormalListenerOwner(c.ownerConfig())
			if e != nil {
				return nil, e
			}
			return &normalComponent{owner: a, done: a.done, result: func() error { a.mu.Lock(); defer a.mu.Unlock(); return a.result }}, nil
		}, component.StabilityLevelDevelopment)
}
func (a *normalComponent) Start(ctx context.Context, host component.Host) error {
	a.mu.Lock()
	if a.started || a.stopping || ctx.Err() != nil {
		a.mu.Unlock()
		return normalLifecycleFailure
	}
	// Factory is available only in generated exclusive mode. Also reject multiple
	// enabled instances/legacy custody in the actual host, not merely YAML defaults.
	if host == nil {
		a.mu.Unlock()
		return normalLifecycleFailure
	}
	n := 0
	for id := range host.GetExtensions() {
		if id.Type() == normalComponentType {
			n++
		}
		if id.Type().String() == "monitoring_custody_test" {
			a.mu.Unlock()
			return normalInvalid
		}
	}
	if n != 1 {
		a.mu.Unlock()
		return normalInvalid
	}
	lifetime, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.started = true
	a.watcherDone = make(chan struct{})
	watcher := a.watcherDone
	a.mu.Unlock() // do not block bounded Shutdown behind store startup/fsync
	if e := a.owner.start(lifetime); e != nil {
		cancel()
		close(watcher)
		return e
	}
	go func() {
		defer close(watcher)
		<-a.done
		a.mu.Lock()
		stopped := a.stopping
		a.mu.Unlock()
		if !stopped {
			componentstatus.ReportStatus(host, componentstatus.NewFatalErrorEvent(normalLifecycleFailure))
		}
	}()
	return nil
}
func (a *normalComponent) Shutdown(ctx context.Context) error {
	a.mu.Lock()
	a.stopping = true
	cancel := a.cancel
	watcher := a.watcherDone
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	// stop retains ownership after deadline and refuses restart. No store close
	// before worker/handler join, and no implication of a backend drain barrier.
	if e := a.owner.stop(ctx); e != nil {
		return e
	}
	if watcher != nil {
		select {
		case <-watcher:
		case <-ctx.Done():
			return normalLifecycleFailure
		}
	}
	if a.result != nil {
		return a.result()
	}
	return nil
}
