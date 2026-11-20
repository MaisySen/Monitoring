# Onboarding snippet incident + regression check (2026-11-21)

Defect: the published Python onboarding snippet (Connect page, Misc.tsx) ended
with plain `python app.py`. It installed dependencies but never activated
auto-instrumentation: a user following the instructions verbatim got a working
app and zero telemetry. Correct guide/demo commands elsewhere masked it.

Evidence:
- snippet-before-0.txt / snippet-after-0.txt: published snippet before/after fix; diff-snippet-0.patch is the one-line change (run line gains `monitoring-run`).
- negative-install.log, negative-run.log, negative-spancount.txt: verbatim BEFORE snippet in a fresh venv (/tmp/vneg) against the validation server: app answered HTTP 200, span count for the service stayed 0.
- positive-run.log: bench/regression/onboarding-snippet.sh against the fixed source: spans 0 -> 1, PASS.
- regression-check-negative-control.log: the same script run against the pre-fix source: correctly FAILs (spans 1 -> 1). (The `exit=0` in that log is the `tee` pipeline's status, not the script's; the script exits non-zero standalone.)

Regression check: bench/regression/onboarding-snippet.sh extracts the snippet
from the published source and runs it verbatim; run it at milestones.
