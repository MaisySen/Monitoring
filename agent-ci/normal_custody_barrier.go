package main

// Read-only authenticated bounded exact-set projection. This route never calls
// freeze, stop, worker.step, lease, admit or recover. Shared Agent stays alive.
const normalBarrierMode = "exact-set-read-only-test-v1"

type normalBarrierInput struct {
	ID         string           `json:"id"`
	Epoch      string           `json:"epoch"`
	Population normalPopulation `json:"population"`
}
type normalBarrierRequest struct {
	Mode   string               `json:"mode"`
	Inputs []normalBarrierInput `json:"inputs"`
}
type normalBarrierRow struct {
	ID         string            `json:"id"`
	Epoch      string            `json:"epoch"`
	Population normalPopulation  `json:"population"`
	Input      *normalInputReply `json:"input"`
}
type normalBarrierReply struct {
	Protocol        string             `json:"protocol"`
	Mode            string             `json:"mode"`
	AgentStopped    bool               `json:"agentStopped"`
	JournalRetained bool               `json:"journalRetained"`
	Rows            []normalBarrierRow `json:"rows"`
}

func normalReadBarrier(raw []byte, read func(string, string) (normalCustodyRecord, error)) (normalBarrierReply, error) {
	out := normalBarrierReply{Protocol: normalCustodyProtocol, Mode: normalBarrierMode, JournalRetained: true, Rows: []normalBarrierRow{}}
	var req normalBarrierRequest
	if normalJSON(raw, &req) != nil || req.Mode != normalBarrierMode || len(req.Inputs) == 0 || len(req.Inputs) > 10 {
		return out, normalInvalid
	}
	seen := map[string]bool{}
	for _, id := range req.Inputs {
		if !normalID.MatchString(id.ID) || !normalID.MatchString(id.Epoch) || !id.Population.valid() || seen[id.ID] {
			return out, normalInvalid
		}
		seen[id.ID] = true
	}
	for _, id := range req.Inputs {
		row := normalBarrierRow{ID: id.ID, Epoch: id.Epoch, Population: id.Population}
		r, e := read(id.ID, id.Epoch)
		if e == nil && r.InputID == id.ID && r.Epoch == id.Epoch && r.Population == id.Population && r.valid() {
			v := normalInputView(r)
			row.Input = &v
		}
		out.Rows = append(out.Rows, row)
	}
	return out, nil
}
