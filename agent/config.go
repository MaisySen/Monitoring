package main

import (
	"bytes"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

type hostMetricsConfig struct {
	Enabled  bool   `yaml:"enabled"`
	Interval string `yaml:"interval"`
	// Connections enables system.network.connections (TCP connection counts by state); off by default.
	Connections bool `yaml:"connections"`
}
type logConfig struct {
	Path    string   `yaml:"path"`
	Service string   `yaml:"service"`
	Source  string   `yaml:"source"`
	Tags    []string `yaml:"tags"`
	StartAt string   `yaml:"start_at"`
}
type custodyTestConfig struct {
	Enabled  bool   `yaml:"enabled"`
	Endpoint string `yaml:"endpoint"`
}
type config struct {
	CustodyTest custodyTestConfig `yaml:"metric_custody_test"`
	APIKey      string            `yaml:"api_key"`
	URL         string            `yaml:"url"`
	Hostname    string            `yaml:"hostname"`
	Env         string            `yaml:"env"`
	Tags        []string          `yaml:"tags"`
	HostMetrics hostMetricsConfig `yaml:"host_metrics"`
	Logs        []logConfig       `yaml:"logs"`
	APM         struct {
		OTLP          bool `yaml:"otlp"`
		DatadogCompat bool `yaml:"datadog_compat"`
	} `yaml:"apm"`
	Dogstatsd struct {
		Enabled bool `yaml:"enabled"`
		Port    int  `yaml:"port"`
	} `yaml:"dogstatsd"`
	Debug bool `yaml:"debug"`
	// Compression for data sent to Monitoring: zstd (default; several times less CPU than gzip at a similar ratio), gzip or none.
	Compression string `yaml:"compression"`
	Listen      string `yaml:"listen"`
	StateDir    string `yaml:"state_dir"`
}

func (c config) compression() string {
	switch c.Compression {
	case "gzip", "none", "zstd", "snappy":
		return c.Compression
	}
	return "zstd"
}

func defaults() config {
	c := config{URL: "http://localhost:3000", Listen: "127.0.0.1", StateDir: "/var/lib/monitoring-agent"}
	c.HostMetrics = hostMetricsConfig{Enabled: true, Interval: "15s"}
	c.APM.OTLP, c.APM.DatadogCompat = true, true
	c.Dogstatsd.Enabled, c.Dogstatsd.Port = true, 8125
	return c
}

func loadConfig(path string) (config, error) {
	c := defaults()
	data, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("read config: %w", err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return c, fmt.Errorf("parse config: %w", err)
	}
	// Expand only explicit ${ENV_VAR} values; never expand arbitrary configuration text.
	for _, target := range []*string{&c.APIKey, &c.URL, &c.Env, &c.Hostname} {
		if strings.HasPrefix(*target, "${") && strings.HasSuffix(*target, "}") {
			key := strings.TrimSuffix(strings.TrimPrefix(*target, "${"), "}")
			value, ok := os.LookupEnv(key)
			if !ok || value == "" {
				return c, fmt.Errorf("environment variable %s is not set", key)
			}
			*target = value
		}
	}
	if c.Env == "" {
		for _, k := range []string{"MONITORING_ENV", "DD_ENV"} {
			if c.Env = os.Getenv(k); c.Env != "" {
				break
			}
		}
	}
	return c, nil
}

type object = map[string]any

func tagsToMap(tags []string) (map[string]string, error) {
	result := map[string]string{}
	for _, tag := range tags {
		key, value, ok := strings.Cut(tag, ":")
		if !ok || strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("invalid tag %q: expected key:value", tag)
		}
		switch key {
		case "host.name", "os.type", "monitoring.agent.version", "deployment.environment", "service.name":
			return nil, fmt.Errorf("tag %q is reserved; use the corresponding configuration field", key)
		}
		result[key] = value
	}
	return result, nil
}

func generateConfig(c config) ([]byte, error) {
	if c.APIKey == "" {
		return nil, fmt.Errorf("api_key is required")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("url must be an http(s) base URL without credentials, query or fragment")
	}
	if strings.ContainsAny(c.APIKey, "\r\n") {
		return nil, fmt.Errorf("api_key must not contain newlines")
	}
	interval, err := time.ParseDuration(c.HostMetrics.Interval)
	if err != nil || interval <= 0 {
		return nil, fmt.Errorf("host_metrics.interval must be a positive duration")
	}
	if c.Dogstatsd.Port < 1 || c.Dogstatsd.Port > 65535 {
		return nil, fmt.Errorf("dogstatsd.port must be between 1 and 65535")
	}
	if c.Listen == "" {
		return nil, fmt.Errorf("listen must not be empty")
	}
	tags, err := tagsToMap(c.Tags)
	if err != nil {
		return nil, err
	}
	attrs := []any{object{"key": "monitoring.agent.version", "value": agentVersion, "action": "upsert"}}
	if c.Env != "" {
		attrs = append(attrs, object{"key": "deployment.environment", "value": c.Env, "action": "upsert"})
	}
	if c.Hostname != "" {
		attrs = append(attrs, object{"key": "host.name", "value": c.Hostname, "action": "upsert"})
	}
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		attrs = append(attrs, object{"key": k, "value": tags[k], "action": "upsert"})
	}
	receivers := object{}
	metrics, logs, traces := []string{}, []string{}, []string{}
	endpoint := func(port int) string { return fmt.Sprintf("%s:%d", c.Listen, port) }
	if c.APM.OTLP {
		receivers["otlp"] = object{"protocols": object{"grpc": object{"endpoint": endpoint(4317)}, "http": object{"endpoint": endpoint(4318)}}}
		metrics, logs, traces = append(metrics, "otlp"), append(logs, "otlp"), append(traces, "otlp")
	}
	if c.APM.DatadogCompat {
		receivers["datadog"] = object{"endpoint": endpoint(8126), "intake": object{"behavior": "disable"}}
		traces = append(traces, "datadog")
	}
	if c.Dogstatsd.Enabled {
		receivers["statsd"] = object{"endpoint": endpoint(c.Dogstatsd.Port), "transport": "udp", "aggregation_interval": "15s", "is_monotonic_counter": true, "enable_simple_tags": true}
		metrics = append(metrics, "statsd")
	}
	if c.HostMetrics.Enabled {
		scrapers := object{}
		for _, s := range []string{"load", "filesystem", "disk", "network", "paging", "processes"} {
			scrapers[s] = object{}
		}
		// Connection-state counts walk every process's sockets in /proc on each scrape (the agent's
		// biggest idle CPU cost); they are opt-in (host_metrics.connections).
		scrapers["network"] = object{"metrics": object{"system.network.connections": object{"enabled": c.HostMetrics.Connections}}}
		scrapers["cpu"] = object{"metrics": object{"system.cpu.utilization": object{"enabled": true}}}
		scrapers["memory"] = object{"metrics": object{"system.memory.utilization": object{"enabled": true}}}
		receivers["hostmetrics"] = object{"collection_interval": c.HostMetrics.Interval, "scrapers": scrapers}
		metrics = append(metrics, "hostmetrics")
	}
	extensions := object{"health_check": object{"endpoint": endpoint(13133)}}
	extensionNames := []string{"health_check"}
	if c.Debug {
		// Go pprof on localhost for profiling the agent (debug: true only).
		extensions["pprof"] = object{"endpoint": "127.0.0.1:1777"}
		extensionNames = append(extensionNames, "pprof")
	}
	if len(c.Logs) > 0 && c.StateDir == "" {
		return nil, fmt.Errorf("state_dir is required when logs are configured")
	}
	// file_storage keeps log-tail offsets and the exporter's send queue on disk, so a restart loses neither.
	if c.StateDir != "" {
		extensions["file_storage"] = object{"directory": c.StateDir, "create_directory": true}
		extensionNames = append(extensionNames, "file_storage")
	}
	if c.CustodyTest.Enabled {
		if c.StateDir == "" || c.CustodyTest.Endpoint == "" {
			return nil, fmt.Errorf("metric_custody_test requires explicit endpoint and state_dir")
		}
		extensions["monitoring_custody_test"] = object{"endpoint": c.CustodyTest.Endpoint, "directory": c.StateDir + "/custody-test", "backend": strings.TrimRight(c.URL, "/"), "api_key": c.APIKey}
		extensionNames = append(extensionNames, "monitoring_custody_test")
	}

	for i, l := range c.Logs {
		if l.Path == "" || l.Service == "" {
			return nil, fmt.Errorf("logs[%d] requires path and service", i)
		}
		if l.StartAt == "" {
			l.StartAt = "end"
		}
		if l.StartAt != "beginning" && l.StartAt != "end" {
			return nil, fmt.Errorf("logs[%d].start_at must be beginning or end", i)
		}
		logTags, err := tagsToMap(l.Tags)
		if err != nil {
			return nil, fmt.Errorf("logs[%d]: %w", i, err)
		}
		resource := object{"service.name": l.Service}
		for k, v := range logTags {
			resource[k] = v
		}
		if l.Source != "" {
			resource["log.source"] = l.Source
		}
		name := fmt.Sprintf("filelog/service_%d", i)
		receivers[name] = object{
			"include": []string{l.Path}, "start_at": l.StartAt, "include_file_path": true,
			"storage": "file_storage", "resource": resource,
			"operators": []any{object{"type": "monitoring_json", "on_error": "send"}},
		}
		logs = append(logs, name)
	}
	exporters := object{"otlphttp/monitoring": object{
		"endpoint": strings.TrimRight(c.URL, "/") + "/otlp", "headers": object{"DC-API-KEY": c.APIKey},
		"compression": c.compression(), "timeout": "30s",
		"retry_on_failure": object{"enabled": true, "initial_interval": "1s", "max_interval": "30s", "max_elapsed_time": "0s"},
		"sending_queue":    object{"enabled": true, "num_consumers": 2, "queue_size": 1000},
	}}
	if c.StateDir != "" {
		exporters["otlphttp/monitoring"].(object)["sending_queue"].(object)["storage"] = "file_storage"
	}
	exporterNames := []string{"otlphttp/monitoring"}
	if c.Debug {
		exporters["debug"] = object{"verbosity": "detailed", "sampling_initial": 5, "sampling_thereafter": 100}
		exporterNames = append(exporterNames, "debug")
	}
	processors := object{
		"memory_limiter": object{"check_interval": "1s", "limit_mib": 256, "spike_limit_mib": 64},
		"resourcedetection": object{"detectors": []string{"system"}, "timeout": "5s", "override": false,
			"system": object{"hostname_sources": []string{"os"}}},
		"resource/monitoring": object{"attributes": attrs},
		"cumulativetodelta":   object{"initial_value": "drop"},
		"batch":               object{"timeout": "200ms", "send_batch_size": 1024, "send_batch_max_size": 2048},
	}
	pipelines := object{}
	for _, p := range []struct {
		name string
		in   []string
	}{{"metrics", metrics}, {"logs", logs}, {"traces", traces}} {
		if len(p.in) == 0 {
			continue
		}
		procs := []string{"memory_limiter", "resourcedetection", "resource/monitoring"}
		if p.name == "metrics" {
			procs = append(procs, "cumulativetodelta")
		}
		procs = append(procs, "batch")
		pipelines[p.name] = object{"receivers": p.in, "processors": procs, "exporters": exporterNames}
	}
	if len(pipelines) == 0 {
		return nil, fmt.Errorf("no telemetry inputs enabled")
	}
	result := object{"receivers": receivers, "processors": processors, "exporters": exporters, "extensions": extensions,
		"service": object{"extensions": extensionNames, "pipelines": pipelines,
			"telemetry": object{"logs": object{"level": "info"}, "metrics": object{"level": "none"}}}}
	return yaml.Marshal(result)
}
