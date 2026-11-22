//go:build !linux

package main

import "time"

// No cross-platform suspend-inclusive source has been validated here. Custody
// remains observable, but no new backend DATA is authorized on these platforms.
func newNormalClock() normalClock {
	return func() normalStamp { return normalStamp{wall: time.Now().UnixMilli()} }
}

func normalBootIdentity() string { return "" } // no validated cross-process clock
