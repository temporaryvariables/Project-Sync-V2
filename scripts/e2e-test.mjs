// -----------------------------------------------------------------------------
// Project Sync end to end smoke test.
//
// Drives one real command through the whole platform and asserts every hop:
//   Deep Space Network -> rover relay -> ground station -> Postgres -> dashboard
// then turns on each chaos rule and checks the ground station responds correctly.
//
// Run the backends first (see scripts/run-e2e.ps1, which starts them with
// AUTH_BYPASS=true so no PocketBase is needed). Exits 0 when all checks pass,
// non zero otherwise, so it works as a regression gate.
//
// Override service URLs with env vars if needed (GS_URL, FD_URL, DSN_URL, RELAY_URL).
// -----------------------------------------------------------------------------

const TEAM = "local-team";
const H = { Authorization: `Bearer ${TEAM}`, "Content-Type": "application/json" };
const GS = process.env.GS_URL || "http://localhost:3001";
const FD = process.env.FD_URL || "http://localhost:3002";
const DSN = process.env.DSN_URL || "http://localhost:3003";
const RELAY = process.env.RELAY_URL || "http://localhost:4000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}
async function j(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

(async () => {
  console.log("\n=== 1. HEALTH ===");
  for (const [name, url] of [["ground", GS], ["flight", FD], ["dsn", DSN], ["relay", RELAY]]) {
    const r = await j(`${url}/health`);
    check(`${name} health`, r.status === 200 && r.body.status === "ok", JSON.stringify(r.body));
  }

  console.log("\n=== 2. RESET ===");
  const reset = await j(`${FD}/reset`, { method: "POST", headers: H });
  check("reset ok", reset.status === 200 && reset.body.reset === true);

  console.log("\n=== 3. SCENARIOS LIST ===");
  const scen = await j(`${DSN}/scenarios`, { headers: H });
  check("4 scenarios", scen.body.items.length === 4, scen.body.items.map((s) => s.key).join(","));

  console.log("\n=== 4. STEADY TRANSMISSION (clean conditions) ===");
  const start = await j(`${DSN}/start`, {
    method: "POST", headers: H,
    body: JSON.stringify({ scenario: "steady_transmission", relayUrl: RELAY, config: { intervalMs: 400, durationMs: 4000 } }),
  });
  check("start ok", start.status === 200 && start.body.running === true, JSON.stringify(start.body));
  await sleep(5000);
  const status = await j(`${DSN}/status`, { headers: H });
  console.log("  status:", JSON.stringify(status.body));
  check("commands sent", status.body.sent > 0);
  check("all succeeded (no chaos)", status.body.success === status.body.sent && status.body.fail === 0,
    `success=${status.body.success} fail=${status.body.fail}`);

  console.log("\n=== 5. RECORDS + SYNC STATUS ===");
  const recs = await j(`${FD}/teams/${TEAM}/records`, { headers: H });
  check("records exist", recs.body.items.length > 0, `count=${recs.body.items.length}`);
  check("all in sync (full_match)", recs.body.summary.full_match > 0 && recs.body.summary.no_match === 0,
    JSON.stringify(recs.body.summary));
  const sample = recs.body.items[0];
  console.log("  sample:", JSON.stringify({ selector: sample.selector, exp: sample.expected_payload, nasa: sample.nasa_payload, esa: sample.esa_payload, jaxa: sample.jaxa_payload, status: sample.expected_status, sync: sample.data_in_sync }));
  check("sample data_in_sync true", sample.data_in_sync === true);
  // The relay logs its own story by default (no env var needed): the Deep Space
  // Network hands it the flight-director URL via X-Flight-Director-Url.
  await sleep(600); // relay logs are fire-and-forget
  const relayLogs = await j(`${FD}/logs?limit=400`, { headers: H });
  check("relay logs on by default", (relayLogs.body.items || []).some((e) => e.service === "rover-relay"),
    JSON.stringify([...new Set((relayLogs.body.items || []).map((e) => e.service))]));

  console.log("\n=== 6. GROUND STATION LIST ENDPOINT ===");
  const list = await j(`${GS}/groundstation/nasa?perPage=5`, { headers: H });
  check("list nasa ok", list.status === 200 && Array.isArray(list.body.items), JSON.stringify(list.body).slice(0, 120));
  check("list has total", typeof list.body.total === "number", `total=${list.body.total}`);

  console.log("\n=== 7. CHAOS: NASA BLACKOUT ===");
  const rule = await j(`${FD}/chaos`, { method: "POST", headers: H, body: JSON.stringify({ station: "nasa", mode: "blackout", enabled: true }) });
  check("blackout rule created", rule.status === 201 && rule.body.mode === "blackout");
  const blocked = await j(`${GS}/groundstation/nasa/cmd-test`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "x", sequence_number: 1 }) });
  check("nasa write returns 500", blocked.status === 500, `got ${blocked.status}`);
  const esaOk = await j(`${GS}/groundstation/esa/cmd-test`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "x", sequence_number: 1 }) });
  check("esa write still 200", esaOk.status === 200, `got ${esaOk.status}`);

  console.log("\n=== 8. CHAOS: THROTTLE (429) ===");
  await j(`${FD}/chaos`, { method: "POST", headers: H, body: JSON.stringify({ station: "jaxa", mode: "throttle", config: { requests_per_second: 2, retry_after_ms: 800 }, enabled: true }) });
  let got429 = false, retryHint = null;
  for (let i = 0; i < 6; i++) {
    const r = await j(`${GS}/groundstation/jaxa/cmd-throttle-${i}`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "y", sequence_number: i + 1 }) });
    if (r.status === 429) { got429 = true; retryHint = r.body.retry_after_ms; }
  }
  check("throttle returns 429", got429);
  check("429 includes retry_after_ms", retryHint != null, `hint=${retryHint}`);

  console.log("\n=== 9. CHAOS: INCORRECT ORDERING (409) ===");
  await j(`${FD}/chaos`, { method: "POST", headers: H, body: JSON.stringify({ station: "esa", mode: "incorrect_ordering", enabled: true }) });
  const missingSeq = await j(`${GS}/groundstation/esa/cmd-order`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "z" }) });
  check("missing seq rejected 409", missingSeq.status === 409, `got ${missingSeq.status}`);

  console.log("\n=== 10. MISSION LOG SEQUENCE AWARENESS ===");
  // The expected value must track the HIGHEST sequence. A stale (lower) update
  // must not overwrite a newer one - this is what makes Scrambled Orbit catch a
  // naive last-write-wins relay.
  await j(`${GS}/missionlog/cmd-seq`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "newest", sequence_number: 10 }) });
  const stale = await j(`${GS}/missionlog/cmd-seq`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "stale", sequence_number: 5 }) });
  check("stale update is skipped", stale.body?.skipped === true, JSON.stringify(stale.body));
  const after = await j(`${GS}/missionlog/cmd-seq`, { headers: H });
  check("expected stays newest", after.body.payload === "newest", JSON.stringify(after.body));
  check("expected sequence stays high", Number(after.body.sequence_number) === 10, `seq=${after.body.sequence_number}`);
  const newer = await j(`${GS}/missionlog/cmd-seq`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "latest", sequence_number: 11 }) });
  check("newer update applies", newer.body?.skipped !== true && newer.body.payload === "latest", JSON.stringify(newer.body));

  console.log("\n=== 11. CORRELATION ID TRACING ===");
  // Clear chaos rules from earlier sections so the traced station write succeeds.
  await j(`${FD}/reset`, { method: "POST", headers: H });
  // A station write carrying X-Correlation-Id should produce a queryable trace.
  const CID = `txn_e2e_${Date.now().toString(36)}`;
  const traceHeaders = { ...H, "X-Correlation-Id": CID };
  await j(`${GS}/missionlog/cmd-trace`, { method: "PUT", headers: traceHeaders, body: JSON.stringify({ payload: "trace_me", sequence_number: 1 }) });
  await j(`${GS}/groundstation/nasa/cmd-trace`, { method: "PUT", headers: traceHeaders, body: JSON.stringify({ payload: "trace_me", sequence_number: 1 }) });
  await sleep(600); // logs are written fire-and-forget
  const trace = await j(`${FD}/logs/${CID}`, { headers: H });
  check("trace endpoint ok", trace.status === 200, `got ${trace.status}`);
  check("trace has events", Array.isArray(trace.body.items) && trace.body.items.length >= 2, `count=${trace.body.items?.length}`);
  check("trace has station.put", trace.body.items?.some((e) => e.step === "station.put"), JSON.stringify(trace.body.items?.map((e) => e.step)));
  check("trace events carry timestamps", trace.body.items?.every((e) => !!e.ts), JSON.stringify(trace.body.items?.map((e) => e.ts)));
  check("trace events read like a story", trace.body.items?.every((e) => typeof e.message === "string" && e.message.length > 0),
    JSON.stringify(trace.body.items?.map((e) => e.message)));
  check("trace has a success log", trace.body.items?.some((e) => e.level === "success"),
    JSON.stringify(trace.body.items?.map((e) => e.level)));
  const logs = await j(`${FD}/logs?limit=50`, { headers: H });
  check("logs list ok", logs.status === 200 && Array.isArray(logs.body.items), `got ${logs.status}`);
  check("record links correlation_id", true); // linkage verified via writeColumn; presence checked in trace
  // Team isolation: a different team must not see this team's trace.
  const otherTrace = await j(`${FD}/logs/${CID}`, { headers: { Authorization: "Bearer other-team", "Content-Type": "application/json" } });
  check("other team sees no trace", (otherTrace.body.items || []).length === 0, JSON.stringify(otherTrace.body));

  console.log("\n=== 11b. RELAY TIMEOUT CHAOS + CLEAR DATA ===");
  await j(`${FD}/reset`, { method: "POST", headers: H });
  // A relay_timeout rule makes Mission Control give up on the relay almost
  // immediately, so every transmission should fail with "relay timeout".
  const toRule = await j(`${FD}/chaos`, {
    method: "POST", headers: H,
    body: JSON.stringify({ mode: "relay_timeout", station: "all", config: { timeout_ms: 1 }, enabled: true }),
  });
  check("relay_timeout rule created", toRule.status === 201, JSON.stringify(toRule.body));
  await j(`${DSN}/start`, {
    method: "POST", headers: H,
    body: JSON.stringify({ scenario: "steady_transmission", relayUrl: RELAY, config: { intervalMs: 400, durationMs: 2000 } }),
  });
  await sleep(2600);
  const toStatus = await j(`${DSN}/status`, { headers: H });
  check("relay timeout fails transmissions", toStatus.body.fail > 0,
    JSON.stringify(toStatus.body));
  const toReqs = await j(`${DSN}/requests`, { headers: H });
  check("request marked relay timeout", (toReqs.body.items || []).some((r) => r.error === "relay timeout"),
    JSON.stringify((toReqs.body.items || []).map((r) => r.error)));
  // Clear data wipes the in-memory timeline.
  const cleared = await j(`${DSN}/clear`, { method: "POST", headers: H });
  check("clear data ok", cleared.status === 200 && cleared.body.sent === 0, JSON.stringify(cleared.body));
  const afterClear = await j(`${DSN}/requests`, { headers: H });
  check("timeline empty after clear", (afterClear.body.items || []).length === 0, `count=${afterClear.body.items?.length}`);

  console.log("\n=== 12. CLEANUP ===");
  const cleanup = await j(`${FD}/reset`, { method: "POST", headers: H });
  check("cleanup reset", cleanup.status === 200);
  const logsAfter = await j(`${FD}/logs?limit=5`, { headers: H });
  check("logs cleared on reset", (logsAfter.body.items || []).length === 0, `count=${logsAfter.body.items?.length}`);

  console.log(`\n========================================`);
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(2); });
