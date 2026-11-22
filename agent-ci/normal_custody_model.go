package main

// Pure versioned record model only. No storage/open/upgrade/wiring side effects.
// Slice2 must atomically persist returned records BEFORE acknowledging custody or
// sending DATA, and use monotonic runtime timing plus restart receipt-only policy.
import (
	"crypto/sha256"
	"encoding/hex"
	"reflect"
)

const normalJournalVersion = 1
const normalJournalNamespace = "node-app-custody-test-v1"
const normalEntryLimit = 128
const normalPayloadLimit = 16 * 1024 * 1024
const normalFileLimit = 128 * 1024 * 1024

// One worker is a TEST head-of-line constraint: one slow backend stalls later
// entries. These ceilings are not throughput/production offline guarantees.
const normalDeliveryWorkers = 1

type normalJournalMeta struct {
	Version      int    `json:"formatVersion"`
	Protocol     string `json:"protocol"`
	Contract     string `json:"contract"`
	Epoch        string `json:"epoch"`
	Binding      string `json:"binding"`
	ClockFloor   int64  `json:"clockFloor"`
	PayloadBytes int64  `json:"payloadBytes"`
	Stored       int64  `json:"stored"`
	Refused      int64  `json:"refused"`
	Unconfirmed  int64  `json:"unconfirmed"`
	FirstUntil   int64  `json:"firstUntil"`
	LastUntil    int64  `json:"lastUntil"`
}

func (m normalJournalMeta) valid(binding string) bool {
	return m.Version == normalJournalVersion && m.Protocol == normalCustodyProtocol && m.Contract == normalContract && normalID.MatchString(m.Epoch) && normalSHA.MatchString(m.Binding) && sameNormalBinding(m.Binding, binding) && m.ClockFloor >= 0 && m.ClockFloor <= normalMaxInteger && m.PayloadBytes >= 0 && m.PayloadBytes <= normalPayloadLimit && m.Stored >= 0 && m.Stored <= normalMaxInteger && m.Refused >= 0 && m.Refused <= normalMaxInteger && m.Unconfirmed >= 0 && m.Unconfirmed <= normalMaxInteger && m.FirstUntil >= 0 && m.FirstUntil <= m.LastUntil && m.LastUntil <= normalMaxInteger
}

type normalCustodyRecord struct {
	ReasonCode       string           `json:"reasonCode"`
	BackendStartedAt int64            `json:"backendStartedAt"`
	Version          int              `json:"formatVersion"`
	InputID          string           `json:"inputId"`
	Epoch            string           `json:"epoch"`
	SHA              string           `json:"sha"`
	Bytes            int64            `json:"bytes"`
	Contract         string           `json:"contract"`
	Population       normalPopulation `json:"producerPopulation"`
	IssuedAt         int64            `json:"issuedAt"`
	InputUntil       int64            `json:"inputUntil"`
	RetainUntil      int64            `json:"retainUntil"`
	AcceptedAt       int64            `json:"acceptedAt"`
	State            string           `json:"state"`
	Body             []byte           `json:"body"`
	Backend          *normalLease     `json:"backend"`
	MayHaveSent      bool             `json:"mayHaveSent"`
	DataAttempts     int              `json:"dataAttempts"`
	ReceiptAttempts  int              `json:"receiptAttempts"`
	LeaseAttempts    int              `json:"leaseAttempts"`
	Stored           *normalStored    `json:"stored"`
}

func (r normalCustodyRecord) valid() bool {
	if r.Version != 1 || !normalReason.MatchString(r.ReasonCode) || !normalID.MatchString(r.InputID) || !normalID.MatchString(r.Epoch) || !normalSHA.MatchString(r.SHA) || r.Bytes <= 0 || r.Bytes > 1048576 || r.Contract != normalContract || !r.Population.valid() || r.IssuedAt <= 0 || r.IssuedAt > normalMaxInteger-330000 || r.InputUntil != r.IssuedAt+30000 || r.RetainUntil != r.InputUntil+300000 || r.AcceptedAt < 0 || r.AcceptedAt >= r.InputUntil || r.DataAttempts < 0 || r.DataAttempts > 3 || r.ReceiptAttempts < 0 || r.ReceiptAttempts > 6 || r.LeaseAttempts < 0 || r.LeaseAttempts > 2 {
		return false
	}
	if len(r.Body) > 0 {
		h := sha256.Sum256(r.Body)
		if int64(len(r.Body)) != r.Bytes || hex.EncodeToString(h[:]) != r.SHA {
			return false
		}
	}
	if r.MayHaveSent != (r.DataAttempts > 0) || r.Backend == nil && (r.MayHaveSent || r.ReceiptAttempts > 0 || r.BackendStartedAt != 0) || r.Backend != nil && (!r.Backend.valid() || r.Backend.SHA != r.SHA || r.Backend.Bytes != r.Bytes || r.LeaseAttempts == 0 || r.BackendStartedAt < r.AcceptedAt || r.BackendStartedAt > normalMaxInteger-60000) {
		return false
	}
	switch r.State {
	case "issued":
		return r.AcceptedAt == 0 && len(r.Body) == 0 && r.Backend == nil && !r.MayHaveSent && r.Stored == nil
	case "custody", "blocked":
		return r.AcceptedAt >= r.IssuedAt && len(r.Body) > 0 && r.Stored == nil
	case "expired-unconfirmed":
		return r.AcceptedAt >= r.IssuedAt && len(r.Body) == 0 && r.Stored == nil
	case "stored":
		return r.AcceptedAt >= r.IssuedAt && r.Backend != nil && r.MayHaveSent && len(r.Body) == 0 && r.Stored != nil && r.Stored.State == "stored" && r.Stored.Protocol == normalCProtocol && r.Stored.ID == r.Backend.ID && r.Stored.SHA == r.SHA && r.Stored.Bytes == r.Bytes && r.Stored.Durability == normalDurability && r.Stored.Accounting.valid() && r.Stored.Accounting.population() == r.Population
	default:
		return false
	}
}

// Return copies to prevent a caller retaining the input buffer/lease from
// mutating a prepared immutable record before the future storage layer commits.
func cloneNormalRecord(r normalCustodyRecord) normalCustodyRecord {
	r.Body = append([]byte(nil), r.Body...)
	if r.Backend != nil {
		x := *r.Backend
		r.Backend = &x
	}
	if r.Stored != nil {
		x := *r.Stored
		r.Stored = &x
	}
	return r
}
func admitNormalInput(r normalCustodyRecord, body []byte, now int64) (normalCustodyRecord, error) {
	if !r.valid() || now < r.IssuedAt || now > r.RetainUntil {
		return normalCustodyRecord{}, normalInvalid
	}
	h := sha256.Sum256(body)
	if int64(len(body)) != r.Bytes || hex.EncodeToString(h[:]) != r.SHA {
		return normalCustodyRecord{}, normalInvalid
	}
	if r.State != "issued" {
		return cloneNormalRecord(r), nil
	} // exact duplicate, no new custody/identity
	if now >= r.InputUntil {
		return normalCustodyRecord{}, normalInvalid
	}
	r = cloneNormalRecord(r)
	r.Body = append([]byte(nil), body...)
	r.AcceptedAt = now
	r.State = "custody"
	return r, nil
}

// Reserve and persist the possibility of a lease request before networking,
// including requests whose response will be lost. No counter reset on restart.
func prepareNormalLeaseAttempt(r normalCustodyRecord) (normalCustodyRecord, error) {
	if !r.valid() || r.State != "custody" || r.Backend != nil || r.MayHaveSent || r.LeaseAttempts >= 2 {
		return normalCustodyRecord{}, normalInvalid
	}
	r = cloneNormalRecord(r)
	r.LeaseAttempts++
	return r, nil
}
func attachNormalLease(r normalCustodyRecord, l normalLease, requestStart int64) (normalCustodyRecord, error) {
	if !r.valid() || r.State != "custody" || r.AcceptedAt == 0 || r.MayHaveSent || r.Backend != nil || r.LeaseAttempts < 1 || r.LeaseAttempts > 2 || requestStart < r.AcceptedAt || requestStart > normalMaxInteger-60000 || !l.valid() || l.SHA != r.SHA || l.Bytes != r.Bytes {
		return normalCustodyRecord{}, normalInvalid
	}
	r = cloneNormalRecord(r)
	r.BackendStartedAt = requestStart
	r.Backend = &l
	return r, nil
}

// No method authorizes a resend. This only prepares the first DATA transition;
// explicit receipt-first recovery eligibility/timing remains slice2 work.
func prepareNormalFirstSend(r normalCustodyRecord) (normalCustodyRecord, error) {
	if !r.valid() || r.State != "custody" || r.Backend == nil || r.MayHaveSent {
		return normalCustodyRecord{}, normalInvalid
	}
	r = cloneNormalRecord(r)
	r.MayHaveSent = true
	r.DataAttempts = 1
	return r, nil
}
func confirmNormalStored(r normalCustodyRecord, status int, body []byte, now int64) (normalCustodyRecord, error) {
	if !r.valid() || r.Backend == nil || !r.MayHaveSent || r.State == "issued" || now < r.AcceptedAt || now > r.RetainUntil || now > r.BackendStartedAt+60000 {
		return normalCustodyRecord{}, normalInvalid
	}
	s, e := validateNormalStored(status, body, *r.Backend)
	if e != nil {
		return normalCustodyRecord{}, e
	}
	if s.Accounting.population() != r.Population {
		return normalCustodyRecord{}, normalInvalid
	}
	// Source population must agree, but is NOT authority to mark stored. Only validated C receipt
	// reaches here; SDK separately checks source population for producer consistency.
	if r.Stored != nil && !reflect.DeepEqual(*r.Stored, s) {
		return normalCustodyRecord{}, normalInvalid
	}
	r = cloneNormalRecord(r)
	r.Stored = &s
	r.State = "stored"
	r.Body = nil
	return r, nil
}

// Conservative local backend-receipt elapsed bound is shorter than retention.
// Backend absolute times are never compared to the Agent wall clock. Expired bytes do not
// acquire a new backend lease. Retain identity for finite status/counters only.
// After local RetainUntil, slice2 may atomically reclaim record+update counters.
func expireNormalRecord(r normalCustodyRecord, now int64) (normalCustodyRecord, bool, error) {
	if !r.valid() || now < r.IssuedAt || now > normalMaxInteger {
		return normalCustodyRecord{}, false, normalInvalid
	}
	r = cloneNormalRecord(r)
	if r.State != "stored" && r.State != "issued" && r.Backend != nil && now > r.BackendStartedAt+60000 {
		r.State = "expired-unconfirmed"
		r.Body = nil
	}
	if r.State != "stored" && r.State != "issued" && now > r.RetainUntil {
		r.State = "expired-unconfirmed"
		r.Body = nil
	}
	return r, now > r.RetainUntil, nil
}
