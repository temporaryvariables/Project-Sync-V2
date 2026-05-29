// End to end smoke test for Project Sync (run with AUTH_BYPASS=true on the backends).
// Team flows through the Bearer token string in bypass mode.
const TEAM = "local-team";
const H = { Authorization: `Bearer ${TEAM}`, "Content-Type": "application/json" };
const GS = "http://localhost:3001";
const FD = "http://localhost:3002";
const DSN = "http://localhost:3003";
const RELAY = "http://localhost:4000";

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

  console.log("\n=== 6. GROUND STATION LIST ENDPOINT (new) ===");
  const list = await j(`${GS}/groundstation/nasa?perPage=5`, { headers: H });
  check("list nasa ok", list.status === 200 && Array.isArray(list.body.items), JSON.stringify(list.body).slice(0, 120));
  check("list has total", typeof list.body.total === "number", `total=${list.body.total}`);

  console.log("\n=== 7. CHAOS: NASA BLACKOUT ===");
  const rule = await j(`${FD}/chaos`, { method: "POST", headers: H, body: JSON.stringify({ station: "nasa", mode: "blackout", enabled: true }) });
  check("blackout rule created", rule.status === 201 && rule.body.mode === "blackout");
  // direct write to nasa should now 500
  const blocked = await j(`${GS}/groundstation/nasa/cmd-test`, { method: "PUT", headers: H, body: JSON.stringify({ payload: "x", sequence_number: 1 }) });
  check("nasa write returns 500", blocked.status === 500, `got ${blocked.status}`);
  // esa should still work
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

  console.log("\n=== 10. CLEANUP ===");
  const cleanup = await j(`${FD}/reset`, { method: "POST", headers: H });
  check("cleanup reset", cleanup.status === 200);

  console.log(`\n========================================`);
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(2); });
