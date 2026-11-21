package main

import (
	"strings"
	"testing"
)

func TestCustodyDisabled(t *testing.T) {
	c := defaults()
	c.APIKey = "synthetic"
	b, e := generateConfig(c)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), "monitoring_custody_test") {
		t.Fatal("disabled custody must not activate")
	}
	c.CustodyTest.Enabled = true
	if _, e = generateConfig(c); e == nil {
		t.Fatal("missing explicit endpoint must fail")
	}
	c.CustodyTest.Endpoint = "127.0.0.1:4438"
	b, e = generateConfig(c)
	if e != nil || !strings.Contains(string(b), "monitoring_custody_test") {
		t.Fatal(e)
	}
}
