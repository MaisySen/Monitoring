//go:build linux

package main

import (
	"crypto/sha256"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"strings"
	"time"
)

func newNormalClock() normalClock {
	start := time.Now()
	return func() normalStamp {
		var b unix.Timespec
		now := time.Now()
		e := unix.ClockGettime(unix.CLOCK_BOOTTIME, &b)
		return normalStamp{now.UnixMilli(), now.Sub(start), time.Duration(b.Sec)*time.Second + time.Duration(b.Nsec), e == nil}
	}
}

func normalBootIdentity() string {
	raw, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if e != nil || len(raw) != 37 {
		return ""
	}
	v := strings.TrimSpace(string(raw))
	if len(v) != 36 {
		return ""
	}
	for i, c := range v {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return ""
			}
		} else if !strings.ContainsRune("0123456789abcdef", c) {
			return ""
		}
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(v)))
}
