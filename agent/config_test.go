package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerate(t *testing.T) {
	c := defaults()
	c.APIKey = "unit-test-key"
	c.Env = "test"
	c.Hostname = "test-host"
	c.Tags = []string{"team:platform"}
	c.Logs = []logConfig{{Path: "/var/log/test.log", Service: "test-service", Source: "test"}}
	out, err := generateConfig(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"DC-API-KEY: unit-test-key", "http://localhost:3000/otlp", "system.cpu.utilization", "system.memory.utilization", "monitoring_json", "service.name: test-service", "cumulativetodelta", "host.name", "deployment.environment", "monitoring.agent.version", "storage: file_storage", "sending_queue:"} {
		if !strings.Contains(string(out), expected) {
			t.Errorf("missing %q", expected)
		}
	}
}

func TestInvalidConfig(t *testing.T) {
	for _, mutate := range []func(*config){
		func(c *config) { c.APIKey = "" },
		func(c *config) { c.URL = "file:///secret" },
		func(c *config) { c.URL = "https://user:pass@example.com" },
		func(c *config) { c.HostMetrics.Interval = "0s" },
		func(c *config) { c.Tags = []string{"no-value"} },
		func(c *config) { c.Tags = []string{"monitoring.agent.version:spoof"} },
		func(c *config) { c.Dogstatsd.Port = 0 },
		func(c *config) { c.Logs = []logConfig{{Path: "/tmp/test"}} },
	} {
		c := defaults()
		c.APIKey = "key"
		mutate(&c)
		if _, err := generateConfig(c); err == nil {
			t.Error("expected validation error")
		}
	}
}

func TestLoadStrictAndEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	t.Setenv("DC_TEST_KEY", "test-key")
	if err := os.WriteFile(path, []byte("api_key: ${DC_TEST_KEY}\nhost_metrics:\n  enabled: false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := loadConfig(path)
	if err != nil || c.APIKey != "test-key" || c.HostMetrics.Enabled {
		t.Fatalf("load failed: %v", err)
	}
	if err := os.WriteFile(path, []byte("api_keey: typo\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(path); err == nil {
		t.Fatal("unknown fields must fail")
	}
}
