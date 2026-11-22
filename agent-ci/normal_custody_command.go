package main

import (
	"errors"
	"sync"

	"go.opentelemetry.io/collector/featuregate"
	"go.opentelemetry.io/collector/otelcol"
	"go.opentelemetry.io/collector/service/pipelines"
)

// Every supported execute entry holds this mutex for its ENTIRE command. It
// excludes raw/default commands while opt-in uses Collector's global alpha gate.
// No supported command may bypass execute or release this lock before return.
var agentCommandMu sync.Mutex
var agentCommandPoisoned bool
var normalGateRestoreFailure = errors.New("normal custody Collector gate restoration failed")

func withAgentCommand(run func() error) error {
	agentCommandMu.Lock()
	defer agentCommandMu.Unlock()
	if agentCommandPoisoned {
		return normalGateRestoreFailure
	}
	return run()
}

type normalPipelineGate interface {
	ID() string
	IsEnabled() bool
}

func withNormalPipelineGate(run func() error) error {
	calls := 0
	return withNormalPipelineGateUsing(pipelines.AllowNoPipelines, func(id string, value bool) error {
		calls++
		e := featuregate.GlobalRegistry().Set(id, value)
		if calls == 2 && e != nil {
			agentCommandPoisoned = true
		} // command mutex still held, including panic unwind
		return e
	}, run)
}

// Purely injectable gate seam for inert tests. Production uses the Collector
// registry exactly once, only within the serialized generated opt-in command.
func withNormalPipelineGateUsing(gate normalPipelineGate, set func(string, bool) error, run func() error) (result error) {
	old := gate.IsEnabled()
	if e := set(gate.ID(), true); e != nil {
		return normalLifecycleFailure
	}
	defer func() {
		if e := set(gate.ID(), old); e != nil {
			result = errors.Join(result, normalGateRestoreFailure)
		}
	}()
	return run()
}
func normalGeneratedComponents() (otelcol.Factories, error) {
	// Deliberately do NOT add normal factory to custodyComponents: raw Collector
	// YAML cannot bypass the generated-only exclusivity checks by naming it.
	f, e := custodyComponents()
	if e != nil {
		return f, e
	}
	f.Extensions[normalComponentType] = newNormalComponentFactory()
	return f, nil
}
