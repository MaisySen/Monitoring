# Validation-bar run: empty account to first useful answer (2026-11-21)

Fresh server instance (port 4731) on a newly created empty database (valrun). Real user path:

1. `fresh-4-onboarding.png` - org "Fresh Shop" created through the setup form; Now shows the
   empty state ("Connect your app", "Nothing to watch yet").
2. `fresh-5-connect.png` - Connect-your-app page: live "Waiting for data..." check, step 1
   create API key (snippet uses a PASTE-YOUR-API-KEY placeholder, key never embedded).
3. Key created via the same endpoint the Organization Settings UI uses (POST /ui/org/keys).
   Shop app (Flask, monitoring-run wrapper) started as v1.0.0 (healthy traffic), then
   "shipped" as v1.1.0: /ok first, then 6x /checkout ValueError.
4. `fresh-7-receiving.png` - Connect page flipped to "Receiving data from shop-api";
   default monitors auto-created ("starting points, not tuned detection").
5. `fresh-6-now.png` - Now page: ALERT NEW ValueError "bad checkout payload" (shop-api,
   auto monitor linked), version-timing chip "v1.1.0 · prod · observed before first
   sighting", 6x first seen 21s ago, workflow actions. Services row honest: "6 errors in
   10 operations - too little traffic to judge overall health", "v1.1.0 first seen (prod)".

Stopwatch: 190 seconds from first page load of the empty server to the answered Now page.
Under the 5-minute bar, with the caveat that this path was scripted (browser automation +
the UI's own endpoints); an unpracticed human is slower. Zero product configuration was
used: no dashboards, no monitor queries, no manual thresholds.

API confirmation of the final state (GET /api/ui/now): receiving=true; exception
{shop-api, ValueError, count 6, versionTiming {version 1.1.0, env prod, versionFirstSeen
strictly before group firstSeen}}; serviceVersions [{shop-api, prod, 1.1.0}].
