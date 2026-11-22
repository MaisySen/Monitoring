package main

// Optional clean SAME-BOOT handoff, never crash recovery or a reusable durable
// DATA permission. Canonical checkpoint consumed synchronously BEFORE permissions.
import (
	"crypto/sha256"
	"fmt"
	"time"
)

const normalResumeMode = "same-boot-never-sent-test-v1"

var normalResumeKey = []byte("clean-never-sent-handoff-v1")

const normalResumeMargin = time.Duration(200) * time.Millisecond

type normalResumeAnchor struct {
	BootID string `json:"bootId"`
	Wall   int64  `json:"wallMs"`
	Boot   int64  `json:"bootNs"`
}
type normalResumeEntry struct {
	ID     string              `json:"id"`
	Epoch  string              `json:"epoch"`
	Digest string              `json:"recordDigest"`
	Issue  normalResumeAnchor  `json:"issueAnchor"`
	Lease  *normalResumeAnchor `json:"leaseAnchor"`
}
type normalResumeCheckpoint struct {
	Version int                 `json:"version"`
	Binding string              `json:"binding"`
	Epoch   string              `json:"journalEpoch"`
	Start   normalResumeAnchor  `json:"start"`
	End     normalResumeAnchor  `json:"end"`
	Entries []normalResumeEntry `json:"entries"`
}
type normalResumeEligibility struct {
	ID           string
	Outcome      string
	Allocation   bool
	FirstDATA    bool
	DeadlineBoot time.Duration
	DeadlineWall int64
}

func normalResumeAnchorFor(bootID string, n normalStamp) normalResumeAnchor {
	if !n.trusted {
		return normalResumeAnchor{}
	}
	return normalResumeAnchor{bootID, n.wall, int64(n.boot)}
}
func (a normalResumeAnchor) valid() bool {
	return normalSHA.MatchString(a.BootID) && a.Wall > 0 && a.Wall <= normalMaxInteger && a.Boot > 0 && a.Boot < int64((1<<63-1)-24*time.Hour)
}
func normalResumeDelta(a, b normalResumeAnchor, limit time.Duration) bool {
	if !a.valid() || !b.valid() || a.BootID != b.BootID || b.Wall < a.Wall || b.Boot < a.Boot {
		return false
	}
	if b.Wall-a.Wall >= limit.Milliseconds() || b.Boot-a.Boot >= int64(limit) {
		return false
	}
	boot := time.Duration(b.Boot - a.Boot)
	wall := time.Duration(b.Wall-a.Wall) * time.Millisecond
	delta := boot - wall
	if delta < 0 {
		delta = -delta
	}
	return boot < limit && wall < limit && delta <= 100*time.Millisecond
}
func (c normalResumeCheckpoint) valid(binding string) bool {
	if c.Version != 1 || c.Binding != binding || !normalSHA.MatchString(c.Binding) || !normalID.MatchString(c.Epoch) || !normalResumeDelta(c.Start, c.End, 24*time.Hour) || len(c.Entries) > normalEntryLimit {
		return false
	}
	seen := map[string]bool{}
	for _, x := range c.Entries {
		if !normalID.MatchString(x.ID) || x.Epoch != c.Epoch || !normalSHA.MatchString(x.Digest) || !normalResumeDelta(x.Issue, c.End, 24*time.Hour) || x.Issue.Boot < c.Start.Boot || x.Issue.Wall < c.Start.Wall || (x.Lease != nil && (!normalResumeDelta(*x.Lease, c.End, 24*time.Hour) || x.Lease.Boot < x.Issue.Boot || x.Lease.Wall < x.Issue.Wall)) || seen[x.ID] {
			return false
		}
		seen[x.ID] = true
	}
	return true
}
func normalResumeDigest(r normalCustodyRecord) string {
	raw, _ := normalDiskEncode(r)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}
func normalResumeNeverSent(r normalCustodyRecord) bool {
	return r.valid() && r.State == "custody" && !r.MayHaveSent && r.DataAttempts == 0 && r.ReceiptAttempts == 0 && len(r.Body) > 0
}

// Plan is PURE. It does not restore anything, and only a proven committed marker
// consumption may publish its eligibility into runtime maps.
func normalPlanResume(c normalResumeCheckpoint, now normalResumeAnchor, rows map[string]normalCustodyRecord) []normalResumeEligibility {
	out := []normalResumeEligibility{}
	trusted := c.valid(c.Binding) && normalResumeDelta(c.Start, now, 24*time.Hour) && normalResumeDelta(c.End, now, 29*time.Second)
	for _, x := range c.Entries {
		e := normalResumeEligibility{ID: x.ID, Outcome: "unconfirmed-no-permission"}
		r, ok := rows[x.ID]
		if !trusted {
			e.Outcome = "clock-or-boot-untrusted"
			out = append(out, e)
			continue
		}
		if !ok || r.Epoch != x.Epoch || normalResumeDigest(r) != x.Digest || !normalResumeNeverSent(r) {
			e.Outcome = "persisted-state-not-proven-never-sent"
			out = append(out, e)
			continue
		}
		// Every wall timestamp used to reconstruct original boot deadline must be
		// covered by SAME original session anchor and final clean sample.
		if r.IssuedAt < c.Start.Wall || r.AcceptedAt < c.Start.Wall || r.AcceptedAt > c.End.Wall {
			out = append(out, e)
			continue
		}
		if x.Issue.Wall != r.IssuedAt || !normalResumeDelta(x.Issue, now, 24*time.Hour) {
			e.Outcome = "original-anchor-untrusted"
			out = append(out, e)
			continue
		}
		horizon := r.InputUntil
		bootHorizon := time.Duration(x.Issue.Boot) + 30*time.Second
		if r.Backend == nil {
			if x.Lease != nil {
				e.Outcome = "unexpected-lease-anchor"
				out = append(out, e)
				continue
			}
			if r.LeaseAttempts >= 2 {
				e.Outcome = "lease-budget-exhausted"
				out = append(out, e)
				continue
			}
		} else {
			if x.Lease == nil || x.Lease.Wall != r.BackendStartedAt || !normalResumeDelta(*x.Lease, now, 24*time.Hour) || r.BackendStartedAt < c.Start.Wall || r.BackendStartedAt > c.End.Wall {
				out = append(out, e)
				continue
			}
			horizon = r.BackendStartedAt + 29000
			if leaseBoot := time.Duration(x.Lease.Boot) + 29*time.Second; leaseBoot < bootHorizon {
				bootHorizon = leaseBoot
			}
			if r.InputUntil < horizon {
				horizon = r.InputUntil
			}
		}
		//200ms margin covers each bounded100ms wall/boot anchor disagreement.
		// Deadline derives from ORIGINAL horizon, never reopen time/new lease time.
		e.DeadlineWall = horizon - normalResumeMargin.Milliseconds()
		if e.DeadlineWall < c.Start.Wall || e.DeadlineWall-c.Start.Wall >= int64((24*time.Hour)/time.Millisecond) {
			out = append(out, e)
			continue
		}
		e.DeadlineBoot = bootHorizon - normalResumeMargin
		if now.Wall >= e.DeadlineWall || time.Duration(now.Boot) >= e.DeadlineBoot {
			e.Outcome = "original-horizon-expired"
			out = append(out, e)
			continue
		}
		e.Allocation = r.Backend == nil
		e.FirstDATA = r.Backend != nil
		if e.Allocation {
			e.Outcome = "never-sent-prelease-original-window"
		} else {
			e.Outcome = "never-sent-original-lease-window"
		}
		out = append(out, e)
	}
	return out
}
