package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/stanza/entry"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/stanza/operator"
	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/stanza/operator/helper"
	"go.opentelemetry.io/collector/component"
)

// A small, in-process Stanza operator preserves integer precision in JSON trace
// context. In particular, uint64 decimal IDs must never pass through float64.
func init() {
	operator.Register("monitoring_json", func() operator.Builder {
		return &jsonLogConfig{TransformerConfig: helper.NewTransformerConfig("monitoring_json", "monitoring_json")}
	})
}

type jsonLogConfig struct {
	helper.TransformerConfig `mapstructure:",squash"`
}

func (c *jsonLogConfig) Build(set component.TelemetrySettings) (operator.Operator, error) {
	base, err := c.TransformerConfig.Build(set)
	if err != nil {
		return nil, err
	}
	return &jsonLogOperator{TransformerOperator: base}, nil
}

type jsonLogOperator struct {
	helper.TransformerOperator
}

func (o *jsonLogOperator) Process(ctx context.Context, e *entry.Entry) error {
	return o.ProcessWith(ctx, e, normalizeLog)
}

func (o *jsonLogOperator) ProcessBatch(ctx context.Context, entries []*entry.Entry) error {
	return o.ProcessBatchWithTransform(ctx, entries, normalizeLog)
}

func normalizeLog(e *entry.Entry) error {
	raw, ok := e.Body.(string)
	if !ok {
		return fmt.Errorf("JSON log body must be a string, got %T", e.Body)
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var data map[string]any
	if err := dec.Decode(&data); err != nil || data == nil {
		e.AddAttribute("monitoring.parse_error", "expected a JSON object")
		return fmt.Errorf("log is not a JSON object; preserving original body")
	}
	if e.Attributes == nil {
		e.Attributes = map[string]any{}
	}
	for k, v := range data {
		e.Attributes[k] = pdataValue(v)
	}
	for _, key := range []string{"message", "msg"} {
		if value, ok := data[key]; ok && value != nil {
			e.Body = pdataValue(value)
			break
		}
	}
	for _, key := range []string{"timestamp", "time", "@timestamp"} {
		if value, ok := data[key].(string); ok {
			if ts, err := time.Parse(time.RFC3339Nano, value); err == nil {
				e.Timestamp = ts
				break
			}
		}
	}
	for _, key := range []string{"level", "status", "severity"} {
		if value, ok := data[key]; ok && value != nil {
			text := strings.ToLower(fmt.Sprint(value))
			e.SeverityText = strings.ToUpper(text)
			switch text {
			case "trace", "10":
				e.Severity = entry.Trace
			case "debug", "20":
				e.Severity = entry.Debug
			case "info", "information", "notice", "30":
				e.Severity = entry.Info
			case "warn", "warning", "40":
				e.Severity = entry.Warn
			case "error", "err", "50":
				e.Severity = entry.Error
			case "fatal", "critical", "crit", "emergency", "alert", "60":
				e.Severity = entry.Fatal
			}
			break
		}
	}
	var failures []string
	for _, id := range []struct {
		key  string
		size int
		dest *[]byte
	}{{"trace_id", 16, &e.TraceID}, {"span_id", 8, &e.SpanID}} {
		value, decimal := contextID(data, id.key)
		if value == "" {
			continue
		}
		parsed, err := parseContextID(value, id.size, decimal)
		if err != nil {
			failures = append(failures, id.key+": "+err.Error())
		} else {
			*id.dest = parsed
		}
	}
	if len(failures) > 0 {
		msg := strings.Join(failures, "; ")
		e.AddAttribute("monitoring.parse_error", msg)
		return fmt.Errorf("invalid log trace context: %s", msg)
	}
	return nil
}

func contextID(data map[string]any, key string) (string, bool) {
	if v := data[key]; v != nil {
		_, numeric := v.(json.Number)
		return fmt.Sprint(v), numeric
	}
	if v := data["dd."+key]; v != nil {
		return fmt.Sprint(v), true
	}
	if dd, ok := data["dd"].(map[string]any); ok && dd[key] != nil {
		return fmt.Sprint(dd[key]), true
	}
	return "", false
}

func parseContextID(value string, size int, decimal bool) ([]byte, error) {
	value = strings.TrimSpace(value)
	// Migration loggers can emit 128-bit trace IDs in hex, but span IDs in decimal.
	isHex := strings.HasPrefix(value, "0x") || strings.ContainsAny(strings.ToLower(value), "abcdef") ||
		(size == 16 && len(value) == 32) || (!decimal && len(value) == size*2)
	if isHex {
		value = strings.TrimPrefix(value, "0x")
		if len(value) > size*2 {
			return nil, fmt.Errorf("hex ID exceeds %d bytes", size)
		}
		value = strings.Repeat("0", size*2-len(value)) + value
		result, err := hex.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("ID is not hexadecimal")
		}
		return result, nil
	}
	n, ok := new(big.Int).SetString(value, 10)
	if !ok || n.Sign() < 0 || n.BitLen() > size*8 {
		return nil, fmt.Errorf("decimal ID exceeds %d bytes or is invalid", size)
	}
	return n.FillBytes(make([]byte, size)), nil
}

func pdataValue(v any) any {
	switch value := v.(type) {
	case json.Number:
		if n, err := value.Int64(); err == nil {
			return n
		}
		// Out-of-range integer IDs stay strings, not rounded floating point values.
		if !strings.ContainsAny(string(value), ".eE") {
			return string(value)
		}
		if n, err := value.Float64(); err == nil {
			return n
		}
		return string(value)
	case map[string]any:
		result := map[string]any{}
		for k, v := range value {
			result[k] = pdataValue(v)
		}
		return result
	case []any:
		result := make([]any, len(value))
		for i, v := range value {
			result[i] = pdataValue(v)
		}
		return result
	default:
		return v
	}
}
