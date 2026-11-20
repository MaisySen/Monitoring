# Monitoring — revised product plan (2026-11-21)

Trigger: user review of the current build (WhatsApp 2026-11-21 04:57:55 AEDT,
wamid.HBgLNjE0Njg2NjEwMjAVAgASGBQzQUJDRjk1MDA5RjNDREU4QUY4RAA=): "This monitor is some
primal ordinary piece that no one would use." That critique is correct, and this plan is the
response. The four-beat journey framing came through the coordinating agent as a proposal,
not verified user requirements; it needs the user's reaction before we call it settled.

## What is wrong with what we built

The current UI replicates Datadog's power-user information architecture (dashboards, metrics
explorer, host map, monitors with hand-written queries, logs/APM explorers). That is a tool for
observability professionals. Multies customers are small businesses and startups: one web app or
API, no observability expert, no time to build dashboards. Every screen in the current build
asks the user to bring expertise (what to graph, what to alert on, how to query) before giving
any value. The first-run experience is empty explorers. That is why it reads as "ordinary":
it is a weaker Datadog, not a useful Multies feature.

The backend we hardened is not wasted. OTLP intake, idempotent spans, spool, quotas,
multi-org isolation, SSO, alerting delivery — all of it stays and carries the new experience.

## The product in one sentence

Connect your app in five minutes; from then on Monitoring tells you when something is wrong,
what broke, why, and what to do next — no dashboards to build, no query language to learn.

## The four-beat experience

### Beat 1 — Connect an app
- One onboarding screen. Pick your stack (Node, Python, Go, Ruby, Java, PHP, .NET, browser),
  get a copy-paste snippet with the endpoint and org key already filled in.
- A live "waiting for data" state that flips to "Receiving data from <service>" the instant
  intake sees the first spans/logs. The user never wonders whether it worked.
- The moment data lands, the opinionated views below exist. Zero configuration.

### Beat 2 — See what's broken (home = answers, not charts)
- New home page, "Now": per-service health line (OK / degraded / down, with the one-line
  reason), and a **Problems** list — computed, deduplicated incidents, e.g.
  "Error rate in `shop-api` 12% (baseline 0.4%) since 14:02. Top new error: TypeError in
  POST /api/checkout. Version v1.4.2 first observed before this exception."
  (A literal "started after deploy" line requires separately recorded deployment evidence -
  a real deploy marker feed - which the product does not have; version-first-observed
  timing is what the data honestly supports today.)
- Default monitors are auto-created per service (error rate, latency, silence/no-data
  heartbeat). Hand-written monitor queries stay available but are never required.

### Beat 3 — Understand why (problem = evidence chain, one page)
- Exception group: message, stack, occurrence count, first/last seen.
- An example failing trace (waterfall exists today), logs scoped to that trace, affected
  endpoints ranked by error count.
- Version-first-observed timing on the incident ("all matched spans in env prod carry
  v1.4.2, first observed there before this exception") - shipped, environment-scoped,
  wording never calls it a deploy. Actual deploy markers on the timeline ("started after
  deploy v1.4.2") require separately recorded deployment evidence and are NOT built.
- New backend work: group error spans/logs by exception fingerprint at intake (new table +
  derivation). Verify span event storage carries exception.type/message/stacktrace; if not,
  extract at intake.

### Beat 4 — What to do next
- Every problem ends in actions: view the failing request, view the exception, acknowledge /
  mute / resolve.
- Multies-native delivery (the part no standalone tool can copy): route a problem into the
  workspace's team chat, notification inbox, mail, or create a task from it in one step.
  Bridge-dependent; phases below mark what needs Multies-side authority.

## The zero-instrumentation entry point: uptime checks

The widest door for a small business: no code change at all. Add a URL, get "is my site up,
how fast, from outside" on a 60 s interval, results in the same Problems feed ("shop.example.com
returning 500 since 09:14"). Server-side prober, small new component (fetch on interval,
status/latency records, heartbeat monitor). This makes Monitoring useful to a customer who
never touches an SDK.

## What gets demoted, not deleted

Dashboard builder, metrics explorer, host map stay as "Advanced" surfaces. Primary nav becomes:
Now / Problems / Services / Errors / Uptime / Deploys (+ Advanced). Infra host-fleet views are
not the audience.

## Phasing

- **P0 — experience core (no new deps):** onboarding flow with live data detection; Now page;
  auto default monitors; service health summary. Reliability fix parked from the resilience
  work (trace.* postcommit undercount window) lands alongside P0 as an independent fix.
- **P1 — understanding:** exception grouping + error pages; version-first-observed timing
  (shipped). True deploy markers need recorded deployment evidence - unbuilt, separate.
- **P2 — reach:** uptime checks; problem acknowledge/resolve; Multies delivery (chat / task /
  mail — needs Multies-side bridge authority, currently held).

## Validation bar (how we prove it is not "ordinary" this time)

1. Demo scenario rebuilt around a small business: a shop API that ships a new version
   introducing a bug. From an empty account, the product must surface the new exception in
   POST /api/checkout on the Now page with its env-scoped version-first-observed timing,
   zero user configuration. Screenshots as proof. (No "deploy" wording anywhere.)
2. Stopwatch test: empty account to first useful answer in under 5 minutes.
3. The user reviews the experience itself this time, not a milestone list.
