// Runs the real session-cleanup script against a fixture sqlite database and
// a fixture opencode API server. The invariants that matter:
//
//   1. classification — archived / superseded / stale land as eligible;
//      shared, recent, --keep and unselected sessions never do
//   2. the database is NEVER written by the script — deletion goes through
//      the API only (fixture DB asserted byte-identical after --apply)
//   3. transcripts are exported to markdown before deletion
//   4. --apply refuses to run when the API is unreachable

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { after, describe, it } = require("node:test");

const ADDON_DIR = path.join(__dirname, "..");
const CHANNEL = path.basename(ADDON_DIR);
const SCRIPT = path.join(ADDON_DIR, "rootfs", "usr", "local", "bin", "session-cleanup");

const DAY = 86400000;
const HOUR = 3600000;
const now = Date.now();

const scratchDirs = [];
const servers = [];

function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const server of servers) server.close();
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function buildFixtureDb(dbPath) {
  const sql = `
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
      slug text NOT NULL, directory text NOT NULL, title text NOT NULL,
      version text NOT NULL, share_url text,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      time_compacting integer, time_archived integer
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE session_share (
      session_id text PRIMARY KEY, id text NOT NULL, secret text NOT NULL,
      url text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL
    );
    INSERT INTO session VALUES
      ('ses_old_arch', 'prj', NULL, 'archived-one', '/homeassistant', 'Archived old session', 'v', NULL,
       ${now - 40 * DAY}, ${now - 40 * DAY}, NULL, ${now - 39 * DAY}),
      ('ses_old_stale', 'prj', NULL, 'stale-one', '/homeassistant', 'Stale old session', 'v', NULL,
       ${now - 35 * DAY}, ${now - 35 * DAY}, NULL, NULL),
      ('ses_parent_old', 'prj', NULL, 'parent-one', '/homeassistant', 'Superseded old parent', 'v', NULL,
       ${now - 35 * DAY}, ${now - 35 * DAY}, NULL, NULL),
      ('ses_child_of_old', 'prj', 'ses_parent_old', 'child-one', '/homeassistant', 'Took over from parent', 'v', NULL,
       ${now - 35 * DAY}, ${now - 1 * DAY}, NULL, NULL),
      ('ses_parent_new', 'prj', NULL, 'parent-two', '/homeassistant', 'Superseded recent parent', 'v', NULL,
       ${now - 1 * HOUR}, ${now - 1 * HOUR}, NULL, NULL),
      ('ses_child_of_new', 'prj', 'ses_parent_new', 'child-two', '/homeassistant', 'Took over recently', 'v', NULL,
       ${now - 30 * 60000}, ${now - 5 * 60000}, NULL, NULL),
      ('ses_shared', 'prj', NULL, 'shared-one', '/homeassistant', 'Shared old session', 'v', NULL,
       ${now - 35 * DAY}, ${now - 35 * DAY}, NULL, NULL),
      ('ses_young', 'prj', NULL, 'young-one', '/homeassistant', 'Recent session', 'v', NULL,
       ${now - 2 * DAY}, ${now - 2 * DAY}, NULL, NULL),
      ('ses_keepme', 'prj', NULL, 'keep-one', '/homeassistant', 'Explicitly kept session', 'v', NULL,
       ${now - 35 * DAY}, ${now - 35 * DAY}, NULL, NULL);
    INSERT INTO session_share VALUES
      ('ses_shared', 'shr', 'x', 'https://example', ${now}, ${now});
    INSERT INTO message VALUES
      ('msg_1', 'ses_old_arch', ${now - 40 * DAY}, ${now - 40 * DAY},
       '{"id":"msg_1","role":"user"}'),
      ('msg_2', 'ses_old_arch', ${now - 40 * DAY + 60000}, ${now - 40 * DAY + 60000},
       '{"id":"msg_2","role":"assistant"}');
    INSERT INTO part VALUES
      ('prt_1', 'msg_1', 'ses_old_arch', ${now - 40 * DAY}, ${now - 40 * DAY},
       '{"type":"text","text":"please check the lights"}'),
      ('prt_2', 'msg_2', 'ses_old_arch', ${now - 40 * DAY}, ${now - 40 * DAY},
       '{"type":"tool","tool":"Bash"}'),
      ('prt_3', 'msg_2', 'ses_old_arch', ${now - 40 * DAY}, ${now - 40 * DAY},
       '{"type":"reasoning","text":"internal"}');
  `;
  fs.writeFileSync(dbPath, "");
  execFileSync("python3", ["-c", `
import sqlite3
con = sqlite3.connect(${JSON.stringify(dbPath)})
con.executescript(${JSON.stringify(sql)})
con.close()
`]);
}

function startFixtureApi() {
  const deleted = [];
  const transcripts = {
    "/session/ses_old_arch/message": [
      { info: { role: "user", time: { created: now - 40 * DAY } },
        parts: [{ type: "text", text: "please check the lights" }] },
      { info: { role: "assistant", time: { created: now - 40 * DAY + 60000 } },
        parts: [{ type: "tool", tool: "Bash" }] },
    ],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (req.method === "GET" && url.pathname === "/session/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const match = url.pathname.match(/^\/session\/(ses_[A-Za-z0-9_]+)\/message$/);
    if (req.method === "GET" && match && transcripts[url.pathname]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(transcripts[url.pathname]));
      return;
    }
    const del = url.pathname.match(/^\/session\/(ses_[A-Za-z0-9_]+)$/);
    if (req.method === "DELETE" && del) {
      deleted.push(del[1]);
      res.writeHead(200);
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  servers.push(server);
  return {
    server,
    deleted: () => deleted,
    ready: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
  };
}

function run(scriptArgs) {
  return execFileSync("python3", [SCRIPT, ...scriptArgs], { encoding: "utf8" });
}

// Async variant: keeps the event loop alive so the fixture API server can
// answer while the script under test is running (execFileSync would freeze it).
async function runAsync(scriptArgs) {
  const { stdout } = await execFileAsync("python3", [SCRIPT, ...scriptArgs], { encoding: "utf8" });
  return stdout;
}

describe(`${CHANNEL} session-cleanup`, () => {
  it("classifies archived, stale and superseded sessions; protects the rest", () => {
    const dir = scratch("session-cleanup-fixture-");
    const db = path.join(dir, "opencode.db");
    buildFixtureDb(db);

    const report = JSON.parse(run(["--db", db, "--json", "--keep", "ses_keepme"]));
    const ids = report.eligible.map((s) => s.id).sort();
    assert.deepEqual(ids, ["ses_old_arch", "ses_old_stale", "ses_parent_old"]);
    assert.equal(report.counts.kept_shared, 1);
    assert.equal(report.counts.kept_young, 3); // young + child_of_old + child_of_new
    assert.equal(report.counts.kept_superseded_recent, 1);
    assert.equal(report.counts.kept_explicit, 1);

    const reasons = Object.fromEntries(report.eligible.map((s) => [s.id, s.reason]));
    assert.equal(reasons.ses_old_arch, "archived");
    assert.equal(reasons.ses_old_stale, "stale");
    assert.equal(reasons.ses_parent_old, "superseded");
  });

  it("deletes only through the API, exports transcripts, never writes the db", async () => {
    const dir = scratch("session-cleanup-fixture-");
    const db = path.join(dir, "opencode.db");
    const exportRoot = path.join(dir, "exports");
    buildFixtureDb(db);
    const fixture = startFixtureApi();
    await fixture.ready();

    const before = fs.readFileSync(db);
    const summary = JSON.parse(await runAsync([
      "--db", db, "--api", `http://127.0.0.1:${fixture.server.address().port}`,
      "--export-root", exportRoot, "--keep", "ses_keepme", "--apply", "--json",
    ]));
    const after = fs.readFileSync(db);
    assert.ok(before.equals(after), "fixture database must be byte-identical after --apply");

    assert.deepEqual(fixture.deleted().sort(), ["ses_old_arch", "ses_old_stale", "ses_parent_old"]);
    assert.equal(summary.deleted.length, 3);
    assert.equal(summary.failed.length, 0);
    assert.ok(summary.export_dir.startsWith(exportRoot));

    // Only ses_old_arch has a canned transcript; 404 on the others must not
    // block their deletion (no file is written for them).
    const exports = fs.readdirSync(exportRoot).flatMap((stamp) =>
      fs.readdirSync(path.join(exportRoot, stamp)).map((f) => path.join(exportRoot, stamp, f)));
    assert.equal(exports.filter((f) => f.endsWith(".md")).length, 1);
    const text = fs.readFileSync(exports.find((f) => f.includes("ses_old_arch")), "utf8");
    assert.match(text, /# Archived old session/);
    assert.match(text, /deleted because: archived/);
    assert.match(text, /please check the lights/);
    assert.match(text, /\[tool: Bash\]/);
    assert.doesNotMatch(text, /internal/); // reasoning parts are skipped
  });

  it("refuses --apply when the api is unreachable", () => {
    const dir = scratch("session-cleanup-fixture-");
    const db = path.join(dir, "opencode.db");
    buildFixtureDb(db);

    let code = 0;
    try {
      execFileSync("python3", [SCRIPT, "--db", db, "--api", "http://127.0.0.1:1", "--apply"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 2, "--apply must fail closed when the opencode server is down");
  });
});
