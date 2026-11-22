package main

// Accepted ownership/lifecycle. Prospective Collector adapter/build wiring is
// explicit opt-in SOURCE ONLY until separately reviewed and executed.
// Construction is inert. Only explicit start opens the owned store and listener.
import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const normalConnectionLimit = 4

var normalLifecycleFailure = errors.New("normal custody lifecycle unavailable")

type normalListenerConfig struct{ Mode, Endpoint, StateDir, Backend, APIKey, ResumeMode string }

func normalListenAddress(raw string) (string, error) {
	host, port, e := net.SplitHostPort(raw)
	if e != nil || (host != "127.0.0.1" && host != "::1") {
		return "", normalInvalid
	}
	p, e := strconv.Atoi(port)
	if e != nil || p < 1 || p > 65535 || strconv.Itoa(p) != port {
		return "", normalInvalid
	}
	canonical := net.JoinHostPort(host, port)
	if canonical != raw {
		return "", normalInvalid
	}
	return canonical, nil
}
func (c normalListenerConfig) validate() error {
	if c.ResumeMode != "" && c.ResumeMode != normalResumeMode {
		return normalInvalid
	}
	endpoint, e := normalListenAddress(c.Endpoint)
	if e != nil || c.Mode != "test-v1" || !filepath.IsAbs(c.StateDir) {
		return normalInvalid
	}
	origin, e := normalOrigin(c.Backend)
	if e != nil {
		return normalInvalid
	}
	if _, e = normalBinding(origin, c.APIKey); e != nil {
		return e
	}
	// Prevent accidental self-forwarding to the custody listener. No redirects or
	// URL resolution from input can change the fixed backend destination.
	u, _ := url.Parse(origin)
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if net.JoinHostPort(u.Hostname(), port) == endpoint {
		return normalInvalid
	}
	return nil
}

// Reserve capacity BEFORE underlying Accept. No accepted-connection drain loop,
// per-refusal goroutine, unbounded queue, or net/http goroutine above this limit.
// Listener.Close unblocks BOTH semaphore wait and underlying Accept, but active
// connection ownership stays with Server.Shutdown/Close and tracked wrappers.
type normalBoundListener struct {
	net.Listener
	mu     sync.Mutex
	closed bool
	stop   chan struct{}
	slots  chan struct{}
	conns  map[*normalBoundConn]bool
	once   sync.Once
}
type normalBoundConn struct {
	net.Conn
	owner *normalBoundListener
	once  sync.Once
}

func newNormalBoundListener(l net.Listener) *normalBoundListener {
	return &normalBoundListener{Listener: l, stop: make(chan struct{}), slots: make(chan struct{}, normalConnectionLimit), conns: map[*normalBoundConn]bool{}}
}
func (l *normalBoundListener) Accept() (net.Conn, error) {
	select {
	case <-l.stop:
		return nil, net.ErrClosed
	case l.slots <- struct{}{}:
	}
	c, e := l.Listener.Accept()
	if e != nil {
		<-l.slots
		return nil, e
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		c.Close()
		<-l.slots
		return nil, net.ErrClosed
	}
	b := &normalBoundConn{Conn: c, owner: l}
	l.conns[b] = true
	return b, nil
}
func (c *normalBoundConn) Close() error {
	var e error
	c.once.Do(func() {
		e = c.Conn.Close()
		l := c.owner
		l.mu.Lock()
		delete(l.conns, c)
		l.mu.Unlock()
		<-l.slots
	})
	return e
}
func (l *normalBoundListener) Close() error {
	var e error
	l.once.Do(func() { l.mu.Lock(); l.closed = true; close(l.stop); l.mu.Unlock(); e = l.Listener.Close() })
	return e
}

// Used after graceful shutdown's deadline and on startup/Serve failure. Close
// snapshots outside the lock, since each wrapper Close removes its ownership.
func (l *normalBoundListener) closeConnections() {
	l.mu.Lock()
	all := make([]*normalBoundConn, 0, len(l.conns))
	for c := range l.conns {
		all = append(all, c)
	}
	l.mu.Unlock()
	for _, c := range all {
		c.Close()
	}
}

// Handler join is independent of socket Close. A blocked synchronous journal
// operation must finish before store.Close; a shutdown deadline cannot pretend
// an interrupted ACK transaction rolled back, nor close DB under its handler.
type normalJoinedHandler struct {
	handler http.Handler
	mu      sync.Mutex
	closing bool
	active  sync.WaitGroup
}

func (h *normalJoinedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		normalRefuse(w, 503)
		return
	}
	h.active.Add(1)
	h.mu.Unlock()
	defer h.active.Done()
	h.handler.ServeHTTP(w, r)
}
func (h *normalJoinedHandler) join() { h.mu.Lock(); h.closing = true; h.mu.Unlock(); h.active.Wait() }

// Tests replace these private effect seams with inert memory resources only.
// Not configurable via HTTP, environment or owner YAML. No raw error logging.
type normalListenerDeps struct {
	open   func(string, string, string) (*normalStore, error)
	listen func(context.Context, string, string) (net.Listener, error)
	run    func(context.Context, *normalWorker)
}

func normalDefaultListenerDeps() normalListenerDeps {
	return normalListenerDeps{
		open: openNormalStore,
		listen: func(ctx context.Context, network, address string) (net.Listener, error) {
			return (&net.ListenConfig{}).Listen(ctx, network, address)
		},
		run: func(ctx context.Context, w *normalWorker) { w.run(ctx) },
	}
}

type normalListenerOwner struct {
	mu            sync.Mutex
	drainMu       sync.Mutex
	cfg           normalListenerConfig
	deps          normalListenerDeps
	started       bool
	stopping      bool
	cancel        context.CancelFunc
	done          chan struct{}
	result        error
	store         *normalStore
	listener      *normalBoundListener
	server        *http.Server
	handler       *normalJoinedHandler
	ingress       *normalIngress
	stopRequested bool
	resumeClock   normalClock
	resumeStart   normalStamp
	resumeBootID  string
}

func newNormalListenerOwner(c normalListenerConfig) (*normalListenerOwner, error) {
	if e := c.validate(); e != nil {
		return nil, e
	}
	return &normalListenerOwner{cfg: c, deps: normalDefaultListenerDeps(), done: make(chan struct{})}, nil
}

// start's context is the LIFETIME parent, not a transient Collector Start context.
// Collector adapter owns a separate lifetime context and explicit stop.
// It must also verify route exclusivity before start. This owner has no knowledge
// of user-created Collector pipelines, SDK instances or another process's modes.
func (a *normalListenerOwner) start(parent context.Context) error {
	a.mu.Lock()
	if a.started || a.stopping || parent.Err() != nil {
		a.mu.Unlock()
		return normalLifecycleFailure
	}
	if e := a.cfg.validate(); e != nil {
		a.mu.Unlock()
		return e
	}
	a.started = true
	ctx, cancel := context.WithCancel(parent)
	a.cancel = cancel
	a.mu.Unlock()
	// Never hold the lifecycle mutex across filesystem/open/listen. A bounded
	// stop can cancel startup and report not-joined even if fsync is stuck.
	fail := func() error {
		cancel()
		a.mu.Lock()
		a.result = normalLifecycleFailure
		close(a.done)
		a.mu.Unlock()
		return normalLifecycleFailure
	}
	if a.cfg.ResumeMode == normalResumeMode {
		a.resumeClock = newNormalClock()
		a.resumeStart = a.resumeClock()
		a.resumeBootID = normalBootIdentity()
	}
	s, e := a.deps.open(a.cfg.StateDir, a.cfg.Backend, a.cfg.APIKey)
	if e != nil {
		return fail()
	}
	if a.cfg.ResumeMode == normalResumeMode {
		// Invalid cross-process clock is fail-closed: consume with wall only restores
		// nothing. Existing receipt/status still works, but no never-sent recovery.
		now := normalResumeAnchorFor(a.resumeBootID, a.resumeClock())
		if now.Wall == 0 {
			now.Wall = time.Now().UnixMilli()
		}
		s.resumeCaptureBoot = a.resumeBootID
		if e = s.consumeGraceful(now); e != nil {
			s.close()
			return fail()
		}
	}
	h, e := newNormalHTTP(a.cfg.Backend, a.cfg.APIKey)
	if e != nil {
		s.close()
		return fail()
	}
	w, e := newNormalWorker(a.cfg.Mode, s, h)
	if e != nil {
		s.close()
		return fail()
	}
	if a.resumeClock != nil {
		w.clock = a.resumeClock
	}
	ingress, e := newNormalIngress(a.cfg.Mode, w)
	if e != nil {
		s.close()
		return fail()
	}
	if ctx.Err() != nil {
		s.close()
		return fail()
	}
	l, e := a.deps.listen(ctx, "tcp", a.cfg.Endpoint)
	if e != nil {
		cancel()
		s.close()
		return fail()
	}
	// Validate the EFFECTIVE bound address too. Config validation is not evidence
	// the resulting listener is loopback or bound to the requested nonzero port.
	if l == nil || l.Addr() == nil || l.Addr().Network() != "tcp" || l.Addr().String() != a.cfg.Endpoint {
		if l != nil {
			l.Close()
		}
		cancel()
		s.close()
		return fail()
	}
	bound := newNormalBoundListener(l)
	joined := &normalJoinedHandler{handler: ingress}
	srv := &http.Server{Handler: joined, MaxHeaderBytes: 8192, ReadHeaderTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: 2 * time.Second, IdleTimeout: time.Second,
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){}, ErrorLog: log.New(io.Discard, "", 0), BaseContext: func(net.Listener) context.Context { return ctx }}
	srv.SetKeepAlivesEnabled(false)
	a.mu.Lock()
	a.store = s
	a.listener = bound
	a.server = srv
	a.handler = joined
	a.ingress = ingress
	a.mu.Unlock()
	serveDone := make(chan error, 1)
	workerDone := make(chan struct{})
	go func() { serveDone <- srv.Serve(bound) }()
	go func() { defer close(workerDone); a.deps.run(ctx, w) }()
	go a.supervise(ctx, cancel, serveDone, workerDone)
	return nil
}
func (a *normalListenerOwner) supervise(ctx context.Context, cancel context.CancelFunc, serveDone <-chan error, workerDone <-chan struct{}) {
	var result error
	served := false
	workerExited := false
	select {
	case <-ctx.Done():
	case e := <-serveDone:
		served = true
		if !errors.Is(e, http.ErrServerClosed) {
			result = normalLifecycleFailure
		}
	case <-workerDone:
		workerExited = true
		if ctx.Err() == nil {
			result = normalLifecycleFailure
		}
	}
	cancel() // abort worker HTTP and inherited handler request contexts first
	a.mu.Lock()
	a.stopping = true
	a.mu.Unlock()
	graceful, c := context.WithTimeout(context.Background(), 2*time.Second)
	if e := a.server.Shutdown(graceful); e != nil {
		result = normalLifecycleFailure
	}
	c()
	// Always close after graceful shutdown too, covering idle/new owned wrappers.
	a.server.Close()
	a.listener.Close()
	a.listener.closeConnections()
	if !served {
		e := <-serveDone
		if !errors.Is(e, http.ErrServerClosed) {
			result = normalLifecycleFailure
		}
	}
	a.handler.join()
	if !workerExited {
		<-workerDone
	}
	a.mu.Lock()
	cleanRequested := a.stopRequested
	a.mu.Unlock()
	if result == nil && cleanRequested && a.cfg.ResumeMode == normalResumeMode {
		end := a.resumeClock()
		if normalElapsed(a.resumeStart, end, 24*time.Hour) && a.resumeBootID != "" {
			if e := a.store.checkpointGraceful(normalResumeAnchorFor(a.resumeBootID, a.resumeStart), normalResumeAnchorFor(a.resumeBootID, end)); e != nil {
				result = normalLifecycleFailure
			}
		}
	}
	if e := a.store.close(); e != nil {
		result = normalLifecycleFailure
	}
	a.mu.Lock()
	a.result = result
	close(a.done)
	a.mu.Unlock()
}

// Timeout reports NOT joined. Cleanup keeps ownership and continues waiting;
// no restart/new owner is allowed, and store remains open until work has joined.
func (a *normalListenerOwner) stop(ctx context.Context) error {
	a.mu.Lock()
	a.stopRequested = true
	if !a.started && !a.stopping {
		a.stopping = true
		close(a.done)
	}
	a.stopping = true
	cancel := a.cancel
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	select {
	case <-a.done:
		a.mu.Lock()
		defer a.mu.Unlock()
		return a.result
	case <-ctx.Done():
		return normalLifecycleFailure
	}
}
