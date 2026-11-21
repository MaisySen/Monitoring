# Current-source acceptance checks, 2026-11-21

Accepted F1-F4 product source: 0c558e370abb9a883e8243e4df5f2255ca618450.
CI build44878114550 completed success for exactly that SHA. Agent artifact14696432658 downloaded
from that run, all five SHA256SUMS entries verified, then packed locally. Binary hashes differ
from the older run despite unchanged source, so these checks use the actual current-run artifact.

- `run-all-current-ci-artifact.log`: nine published-path regression checks, all pass, pipefail,
  exit0, current-built server and newly packed current-run agent artifact.
- `default-install-namespace.log`: real default /opt, /etc and /var/lib paths in a private local
  user/PID/mount namespace, no MONITORING_PREFIX. Unmodified served installer, executable binary,
  namespace-root-owned config0600. Actual agent ran40s and shut down cleanly on intentional timeout.
- `default-install-stored-summary.json`:394 stored metric points,177 series, synthetic host linked
  to system. Positive end-to-end storage check, not only process startup.
- Actual systemd lifecycle is still unverified here: isolated systemd did not start, PID1 of the
  host is not systemd and writable cgroup delegation is absent. No VM reboot test was performed.
- `harness90s-smoke.log`: startup/probe check for the new bounded CI harness, intentionally timed
  out after90s. Two samples, query/discovery/host probes and planted alert/normal states worked.
  This is NOT a completed soak or a successful-duration claim. Owned smoke monitors cleaned up.

The manual acceptance workflow pins this product source and agent build, uses a standard
ubuntu24.04 VM only while the repository is public, disables artifact/cache uploads, and keeps
services on loopback. Only synthetic local identities and telemetry are used; credentials and
server response bodies are not printed. Hard job timeout215min, soak step190min, duration limited
to5min harness smoke or180min sustained test; disk guard3GB and memory guard512MB.20 traces/s,
10 hosts,8 services,200 metric cardinality. No capacity claim. It separately tests systemd
start/stop/start/restart on the disposable VM, not a machine reboot.

Free-standard-runner and storage distinctions verified from GitHub docs:
https://docs.github.com/en/billing/concepts/product-billing/github-actions
https://docs.github.com/en/actions/reference/runners/github-hosted-runners
No new artifact/cache storage is created; evidence is emitted to logs/job summary instead.

Retry defaultOFF, opt-in TEST-ONLY. Postcommit metadata failures may be acknowledged by a later
duplicate without repair until another fresh batch; per-org point-quota row serialization remains
a throughput consideration. Retention/config and already-in-flight send limits remain unchanged.
