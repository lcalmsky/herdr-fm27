import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ClaudeAccounts, { launchLine, launchFor, resumeArgs, resumeTemplates, errorText,
  parsePorcelain, codexLaunch, staffKey, staffRows, staffWindows, windowCell, otherAgents } from "../mods/fm-staff/main.js";
import { fableOf } from "../mods/fm-staff/usage-api.mjs";
import { emailOf, rateLimitsOf } from "../mods/fm-staff/codex-usage.mjs";
import { defaultUsage, matchEnv, parseModels, parseUsage, slug, usageCommand } from "../mods/fm-staff/models.mjs";

const codexUsage = fileURLToPath(new URL("../mods/fm-staff/codex-usage.mjs", import.meta.url));
const codexEvent = JSON.stringify({ type: "event_msg", payload: { rate_limits: {
  primary: { used_percent: 33, window_minutes: 300, resets_at: 1794208378 },
  secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1794795178 },
  plan_type: "plus" } } });

const runLine = (line) => execFileSync("sh", ["-c", line], { env: { ...process.env, SHELL: "/bin/sh" } }).toString();

test("plain claude keeps the direct exec", () => {
  assert.equal(launchLine("CCA_ACCOUNT=work", "claude", " --resume abc"), "CCA_ACCOUNT=work exec claude --resume abc");
});

test("another start command runs through the interactive shell with the account env and args", () => {
  const line = launchLine("CCA_ACCOUNT=work", "printf '%s|%s|%s' \"$CCA_ACCOUNT\"", " --resume abc");
  assert.match(line, /exec "\$\{SHELL:-\/bin\/zsh\}" -ic /);
  assert.equal(runLine(line), "work|--resume|abc");
});

test("launchFor keeps today's line for the Claude accounts", () => {
  assert.equal(launchFor("default", " --resume abc", "claude"),
    "unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=default exec claude --resume abc");
  assert.equal(launchFor("work", "", "claude"),
    'CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/work" CCA_ACCOUNT=work exec claude');
  assert.equal(launchFor("work", " --resume abc", "ccode"),
    'CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/work" CCA_ACCOUNT=work exec "${SHELL:-/bin/zsh}" -ic \'ccode --resume abc\'');
});

test("a model runs its command through the interactive shell with CLAUDE_CONFIG_DIR unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-launch-"));
  try {
    writeFileSync(join(dir, "grok"), '#!/bin/sh\nprintf "%s|%s|%s\\n" "${CLAUDE_CONFIG_DIR-unset}" "$CCA_ACCOUNT" "$*"\n');
    chmodSync(join(dir, "grok"), 0o755);
    const model = { name: "grok", kind: "model", command: "grok --model grok-4" };
    const line = launchFor(model, " --resume abc");
    assert.equal(line,
      'unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=grok exec "${SHELL:-/bin/zsh}" -ic \'grok --model grok-4 --resume abc\'');
    const out = execFileSync("sh", ["-c", line], {
      env: { ...process.env, SHELL: "/bin/sh", PATH: `${dir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: "/tmp/elsewhere" },
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    assert.equal(out, "unset|grok|--model grok-4 --resume abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model's resume args come from its template, a Claude account's from --resume", () => {
  const model = { name: "grok", kind: "model", command: "grok", resume: "--resume {id} --continue" };
  assert.equal(resumeArgs(model, "abc"), " --resume abc --continue");
  assert.equal(resumeArgs({ name: "work" }, "abc"), " --resume abc");
  assert.equal(resumeArgs({ kind: "model", resume: null }, "abc"), null);
  assert.equal(launchFor(model, resumeArgs(model, "abc")),
    'unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=grok exec "${SHELL:-/bin/zsh}" -ic \'grok --resume abc --continue\'');
});

test("continuing as a model puts its {id}-substituted template in the pane command", () => {
  const v = Object.create(ClaudeAccounts.prototype);
  globalThis.herdrRuns = [];
  try {
    const model = { name: "grok", kind: "model", command: "grok --model grok-4", resume: "--resume {id} --continue" };
    const session = { id: "12345678-1234-1234-1234-123456789abc", cwd: "/tmp/my work" };
    v.continueAs(model, session);
    assert.deepEqual(globalThis.herdrRuns, [["pane.split", { direction: "right", argv: ["sh", "-lc",
      `cd '/tmp/my work' && ${launchFor(model, resumeArgs(model, session.id))}`] }]]);
    assert.match(globalThis.herdrRuns[0][1].argv[2], /--resume 12345678-1234-1234-1234-123456789abc --continue/);
  } finally {
    globalThis.herdrRuns = undefined;
  }
});

test("continuing as a Claude account row resumes under that account's config folder", async () => {
  const v = Object.create(ClaudeAccounts.prototype);
  globalThis.herdrRuns = [];
  try {
    const account = { name: "personal", label: "personal", email: "", usage: null };
    const session = { id: "12345678-1234-1234-1234-123456789abc", cwd: "/tmp/my work" };
    v.continueAs(account, session);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(globalThis.herdrRuns, [["pane.split", { direction: "right", argv: ["sh", "-lc",
      `cd '/tmp/my work' && ${launchFor("personal", " --resume 12345678-1234-1234-1234-123456789abc")}`] }]]);
  } finally {
    globalThis.herdrRuns = undefined;
  }
});

test("the popup asks for the resumed pane before it closes itself, with the command it already read", () => {
  const v = Object.create(ClaudeAccounts.prototype);
  v.launch = "ccode";
  const order = [];
  globalThis.herdrState = { props: { overlay: "o9" } };
  globalThis.herdrRuns = { push: (args) => order.push(["run", args[0]]) };
  globalThis.herdrClosed = { push: (id) => order.push(["close", id]) };
  try {
    v.continueAs({ name: "personal" }, { id: "12345678-1234-1234-1234-123456789abc", cwd: "/tmp/w" });
    assert.deepEqual(order, [["run", "pane.split"], ["close", "o9"]]);
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrRuns = undefined;
    globalThis.herdrClosed = undefined;
  }
});

test("resume templates keep the first usable entry per id and skip the rest", () => {
  const text = JSON.stringify([
    { id: "codex", command: "claude-gpt", resume: "--resume {id}" },
    { id: "codex", command: "other", resume: "--later {id}" },
    { id: "plain", command: "plain" },
    { id: "plain", command: "plain2", resume: "--later {id}" },
    { id: "dated", command: "v1", resume: "first {id}" },
    { id: "dated", command: "v2", resume: "second {id}" },
    { id: "Bad Id", command: "x", resume: "--resume {id}" },
    { id: "late", resume: "--resume {id}" },
    { id: "split", command: "x", resume: "two\tlines" },
    null,
    "nope",
  ]);
  assert.deepEqual(resumeTemplates(text), { codex: "--resume {id}", dated: "first {id}" });
  assert.deepEqual(resumeTemplates("{bad"), {});
  assert.deepEqual(resumeTemplates(""), {});
  assert.deepEqual(resumeTemplates('{"id":"x"}'), {});
});

test("the Staff keys move the highlight and wrap, run or open the row shown, and cancel an editor", () => {
  assert.deepEqual(staffKey("down", 0, 3, false), { at: 1, cancelEdit: false, run: false, open: false });
  assert.deepEqual(staffKey("down", 2, 3, false), { at: 0, cancelEdit: false, run: false, open: false }, "↓ wraps to the first row");
  assert.deepEqual(staffKey("up", 0, 3, false), { at: 2, cancelEdit: false, run: false, open: false }, "↑ wraps to the last row");
  assert.deepEqual(staffKey("enter", 1, 3, false), { at: 1, cancelEdit: false, run: true, open: false });
  assert.deepEqual(staffKey("space", 0, 3, false), { at: 0, cancelEdit: false, run: true, open: false });
  assert.deepEqual(staffKey("o", 1, 3, false), { at: 1, cancelEdit: false, run: false, open: true });
  assert.deepEqual(staffKey("escape", 1, 3, true), { at: 1, cancelEdit: true, run: false, open: false });
  assert.equal(staffKey("down", 0, 3, true), null, "an open editor owns the keyboard");
  assert.equal(staffKey("o", 0, 3, true), null, "an open editor owns the keyboard");
  assert.equal(staffKey("down", 0, 0, false), null, "an empty table takes no key");
  assert.equal(staffKey("escape", 0, 3, false), null, "Esc with no editor open is the host's");
});

test("a failure line drops its full stop and falls back to the next step", () => {
  assert.equal(errorText({ stderr: "boom.\n" }, "fallback"), "boom");
  assert.equal(errorText({ stderr: "bad name.", stdout: "worse" }, "fallback"), "bad name");
  assert.equal(errorText({ stdout: "" }, "fallback"), "fallback");
  assert.equal(errorText(null, "fallback"), "fallback");
});

test("only one in-place editor is open at a time, so the screen's single hint line fits", () => {
  const v = Object.create(ClaudeAccounts.prototype);
  const cx = { notify() {}, timer: { after() {} } };
  v.launch = "claude";
  v.startLaunchEdit(cx);
  v.startRename({ name: "work" }, cx);
  assert.equal(v.launchEdit, null);
  assert.equal(v.rename.name, "work");
  v.startLaunchEdit(cx);
  assert.equal(v.rename, null);
  assert.ok(v.launchEdit);
});

test("the Staff table budgets 5h and the week, an Ultra plan's week from its Fable window", () => {
  const usage = { five: { used: 12, reset: null }, seven: { used: 9, reset: null }, fable: { used: 30, reset: null } };
  const vals = (a) => staffWindows(a).map(([label, w]) => [label, w?.used ?? null]);
  assert.deepEqual(vals({ plan: null, usage }), [["5h", 12], ["7d", 9]]);
  assert.deepEqual(vals({ plan: "Ultra", usage }), [["5h", 12], ["7d", 30]]);
  assert.deepEqual(vals({ plan: "Ultra", usage: { five: null, seven: { used: 9 }, fable: null } }), [["5h", null], ["7d", 9]]);
  assert.deepEqual(vals({ plan: null, usage: null }), [["5h", null], ["7d", null]]);
});

test("a wage-budget cell carries its percentage, the 90 % warning and the reset label", () => {
  const now = Date.now() / 1000;
  const later = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date((now + 3 * 86400) * 1000).getDay()];
  const soon = new Date((now + 3600) * 1000);
  const clock = `${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;
  assert.deepEqual(windowCell(["7d", { used: 42.4, reset: now + 3 * 86400 }]), { label: "7d", pct: 42, hot: false, reset: later });
  assert.deepEqual(windowCell(["5h", { used: 10, reset: now + 3600 }]), { label: "5h", pct: 10, hot: false, reset: clock }, "within a day the reset is a clock time");
  assert.deepEqual(windowCell(staffWindows({ usage: { five: { used: 92, reset: now - 10 } } })[0]),
    { label: "5h", pct: 0, hot: false, reset: null }, "a spent window reads 0 % and has no reset");
  assert.deepEqual(windowCell(["5h", { used: 95, reset: null }]), { label: "5h", pct: 95, hot: true, reset: null });
  assert.deepEqual(windowCell(["5h", null]), { label: "5h", pct: null, hot: false, reset: null });
});

const staffSample = () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  return parsePorcelain([
    "C\twork",
    "D\tpersonal",
    "A\tdefault\tw@x",
    "A\twork\tp@x",
    "A\tpersonal\tme@x",
    "M\tgpt\tclaude-gpt\t1",
    "M\tgemini\tgemini\t0",
    "U\tdefault\t12\t\t9\t\t\t",
    "U\twork\t92\t\t47\t\t\t",
    "U\tgpt\t33\t\t5\t\t\t",
    "P\twork\tMax",
    `S\t${id}\t/tmp/my work`,
    "Y\twork",
    "X\tdefault\tcodex@x",
    "X\twork\twork@x",
    "L\tcodex:work\tWork Codex",
  ].join("\n"));
};

const staffRowsOf = (p, extra = {}) => staffRows({
  accounts: [...p.accounts, ...p.models], codex: p.codex, globalDefault: p.globalDefault,
  current: p.current, session: p.session, ...extra,
});

test("the Staff rows list Claude, Codex, custom commands and the start command in order", () => {
  const rows = staffRowsOf(staffSample(), { launch: "ccode" });
  assert.deepEqual(rows.filter((r) => r.kind === "group").map((r) => r.title),
    ["Claude", "Codex", "Custom commands", "Start command"]);
  assert.deepEqual(rows.filter((r) => r.kind !== "group").map((r) => r.id),
    ["claude:default", "claude:work", "claude:personal", "add-claude", "codex:default", "codex:work",
      "add-codex", "model:gpt", "model:gemini", "add-custom", "start"]);
  assert.deepEqual(rows.filter((r) => r.kind === "add").map((r) => r.text),
    ["+ Sign a Claude account", "+ Sign a Codex login", "+ Add custom command"]);
  assert.deepEqual(rows.filter((r) => r.kind !== "group").map((r) => r.alt),
    [true, false, true, false, true, false, true, false, true, false, true],
    "the data rows alternate for the faint zebra");
  const start = rows.find((r) => r.kind === "start");
  assert.equal(start.value, "ccode");
  assert.equal(start.sub, "runs through your shell when it is not claude");
});

test("a Claude row names its login, marks where new sessions sign and offers its actions", () => {
  const rows = staffRowsOf(staffSample(), { launch: "claude" });
  const work = rows.find((r) => r.id === "claude:work");
  assert.equal(work.display, "work");
  assert.equal(work.sub, "p@x, this pane");
  assert.equal(work.radio, false, "personal is the global default");
  assert.equal(work.contract, "");
  assert.deepEqual(work.actions.map((a) => a.label), ["new pane", "rename"],
    "the account this pane runs cannot resume itself here");
  assert.deepEqual(work.windows.map((w) => [w.label, w.pct, w.hot]), [["5h", 92, true], ["7d", 47, false]]);
  const personal = rows.find((r) => r.id === "claude:personal");
  assert.equal(personal.display, "personal");
  assert.equal(personal.sub, "me@x");
  assert.equal(personal.radio, true);
  assert.equal(personal.contract, "New sessions sign here");
  assert.deepEqual(personal.actions.map((a) => a.label), ["new pane", "rename", "transfer this session here"]);
});

test("a Codex row marks the active login and a custom command shows its contract and usage", () => {
  const rows = staffRowsOf(staffSample());
  const sys = rows.find((r) => r.id === "codex:default");
  assert.equal(sys.display, "System default");
  assert.equal(sys.sub, "~/.codex");
  assert.equal(sys.radio, false);
  assert.equal(sys.contract, "");
  const work = rows.find((r) => r.id === "codex:work");
  assert.equal(work.display, "Work Codex");
  assert.equal(work.sub, "work@x");
  assert.equal(work.radio, true);
  assert.equal(work.contract, "New Codex sessions");
  assert.deepEqual(work.actions.map((a) => a.id), ["open", "rename"], "Codex sessions are not resumed as Claude");
  const gpt = rows.find((r) => r.id === "model:gpt");
  assert.equal(gpt.sub, "claude-gpt");
  assert.equal(gpt.contract, "Resumable");
  assert.equal(gpt.untracked, false);
  assert.deepEqual(gpt.actions.map((a) => a.id), ["open", "rename", "transfer"]);
  assert.deepEqual(gpt.windows.map((w) => [w.label, w.pct]), [["5h", 33], ["7d", 5]]);
  const gemini = rows.find((r) => r.id === "model:gemini");
  assert.equal(gemini.contract, "");
  assert.equal(gemini.untracked, true, "a command with no usage spans the two budget columns");
});

test("without a focused Claude session no row offers a transfer", () => {
  const rows = staffRowsOf(staffSample(), { session: null });
  assert.ok(rows.every((r) => !Array.isArray(r.actions) || !r.actions.some((a) => a.id === "transfer")));
});

test("parsePorcelain reads every line kind into accounts, models, labels and the Codex list", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const text = [
    "C\twork",
    "D\tpersonal",
    "A\tdefault\tw@x",
    "A\twork\tp@x",
    "M\tgpt\tclaude-gpt\t1",
    "U\tdefault\t12\t100\t9\t200\t\t",
    "P\tdefault\tMax",
    "L\tdefault\tMe",
    "L\tgpt\tGPT",
    `S\t${id}\t/tmp/my work`,
    "Y\twork",
    "X\tdefault\tcodex@x",
    "X\twork\twork@x",
    "V\twork\t33\t1000\t5\t2000",
    "Q\twork\tChatGPT Plus",
    "L\tcodex:work\tWork Codex",
  ].join("\n");
  const p = parsePorcelain(text);
  assert.equal(p.current, "work");
  assert.equal(p.globalDefault, "personal");
  assert.deepEqual(p.session, { id, cwd: "/tmp/my work" });
  assert.deepEqual(p.accounts.map((a) => [a.name, a.email, a.label]), [["default", "w@x", "Me"], ["work", "p@x", null]]);
  assert.deepEqual(p.accounts[0].usage, { five: { used: 12, reset: 100 }, seven: { used: 9, reset: 200 }, fable: null });
  assert.equal(p.accounts[0].plan, "Max");
  assert.deepEqual(p.models.map((m) => [m.name, m.kind, m.command, m.resumable, m.label]),
    [["gpt", "model", "claude-gpt", true, "GPT"]]);
  assert.equal(p.codex.active, "work");
  assert.deepEqual(p.codex.accounts.map((c) => [c.name, c.email, c.plan, c.label]), [
    ["default", "codex@x", null, null],
    ["work", "work@x", "ChatGPT Plus", "Work Codex"],
  ]);
  assert.deepEqual(p.codex.accounts[1].usage,
    { five: { used: 33, reset: 1000 }, seven: { used: 5, reset: 2000 }, fable: null });
  assert.equal(p.codex.accounts[0].usage, null);
});

test("parsePorcelain always offers the system Codex login and ignores broken lines", () => {
  const p = parsePorcelain("X\tbad name\tx\nY\tbad name\nV\t\nQ\t");
  assert.deepEqual(p.codex, { active: "default", accounts: [{ name: "default", email: "", usage: null, plan: null, label: null }] });
  assert.deepEqual(parsePorcelain(""), {
    current: "default", globalDefault: "default", session: null,
    accounts: [], models: [], labels: {},
    codex: { active: "default", accounts: [{ name: "default", email: "", usage: null, plan: null, label: null }] },
  });
});

test("codexLaunch quotes the run words and keeps $HOME outside the quotes", () => {
  assert.equal(codexLaunch(null, ["codex", "--full-auto"]), "exec 'codex' '--full-auto'");
  assert.equal(codexLaunch("/tmp/x", ["codex"]), "CODEX_HOME='/tmp/x' exec 'codex'");
  assert.equal(codexLaunch("/tmp/it's here", ["codex", "a b"]), `CODEX_HOME='/tmp/it'\\''s here' exec 'codex' 'a b'`);
  assert.match(codexLaunch("~/.codex-accounts/work", ["codex"]), /^CODEX_HOME="\$HOME"\/'.codex-accounts\/work' exec 'codex'$/);
});

test("cca prints the plan and the Fable window from the usage endpoint's record", () => {
  const home = execFileSync("mktemp", ["-d"]).toString().trim();
  const state = `${home}/state/herdr-tower/usage`;
  execFileSync("mkdir", ["-p", state, `${home}/.claude-accounts/personal`]);
  const fs = { "/.claude.json": '{"oauthAccount":{"emailAddress":"w@x","planDisplayName":"Ultra"}}',
    "/.claude-accounts/personal/.claude.json": '{"oauthAccount":{"emailAddress":"p@x"}}' };
  for (const [f, body] of Object.entries(fs)) execFileSync("sh", ["-c", 'printf %s "$1" > "$2"', "x", body, home + f]);
  execFileSync("sh", ["-c", 'printf %s "$1" > "$2"', "x", '{"seven_day":{"used":9,"resets_at":4102444800}}', `${state}/default.json`]);
  execFileSync("sh", ["-c", 'printf %s "$1" > "$2"', "x", '{"fetched_at":1,"fable":{"used":3,"resets_at":4102444800}}', `${state}/default.api.json`]);
  execFileSync("touch", [`${state}/.api-fetch`]);
  const out = execFileSync("sh", ["mods/fm-staff/cca", "--porcelain"],
    { env: { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` } }).toString();
  assert.match(out, /^P\tdefault\tUltra$/m);
  assert.match(out, /^U\tdefault\t\t\t9\t4102444800\t3\t4102444800$/m);
  assert.doesNotMatch(out, /^P\tpersonal/m);
  execFileSync("rm", ["-rf", home]);
});

// A temp HOME with the usage folder's stamp already fresh, so cca never reaches the network.
const towerHome = (prefix) => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(`${home}/state/herdr-tower/usage`, { recursive: true });
  writeFileSync(`${home}/state/herdr-tower/usage/.api-fetch`, "");
  return home;
};

test("cca use accepts a model id, and an unknown name is refused as no account or agent", () => {
  const home = towerHome("use-model-");
  try {
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([{ id: "gpt", command: "claude-gpt" }]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const use = (...args) => spawnSync("sh", [cca, "use", ...args], { env, encoding: "utf8" });

    const chosen = use("gpt");
    assert.equal(chosen.status, 0);
    assert.equal(chosen.stdout.trim(), "gpt");
    assert.equal(readFileSync(`${home}/state/herdr-tower/current`, "utf8").trim(), "gpt");
    const porcelain = spawnSync("sh", [cca, "--porcelain"], { env, encoding: "utf8" });
    assert.match(porcelain.stdout, /^D\tgpt$/m);

    const unknown = use("nope");
    assert.equal(unknown.status, 3);
    assert.equal(unknown.stderr.trim(), "cca: No account or agent nope.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a model named codex is usable, while a folder named codex is refused", () => {
  const home = towerHome("use-codex-");
  try {
    writeFileSync(`${home}/state/herdr-tower/models.json`,
      JSON.stringify([{ id: "codex", label: "Codex", command: "claude-gpt" }]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const run = (...args) => spawnSync("sh", [cca, ...args], { env, encoding: "utf8" });

    const chosen = run("use", "codex");
    assert.equal(chosen.status, 0);
    assert.equal(chosen.stdout.trim(), "codex");
    assert.equal(run("current").stdout.trim(), "codex");

    const add = run("add", "codex");
    assert.equal(add.status, 2);
    assert.equal(add.stderr.trim(), "codex is a cca command.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca codex add links ~/.codex's config and sessions but leaves auth.json and machine state behind", () => {
  const home = towerHome("codex-add-");
  try {
    mkdirSync(`${home}/.codex/sessions/2026/11/09`, { recursive: true });
    writeFileSync(`${home}/.codex/config.toml`, 'model = "gpt-5"\n');
    writeFileSync(`${home}/.codex/auth.json`, '{"tokens":{"id_token":"x"}}');
    writeFileSync(`${home}/.codex/state.sqlite`, "db");
    writeFileSync(`${home}/.codex/.tmp`, "tmp");
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const run = (...args) => spawnSync("sh", [cca, ...args], { env, encoding: "utf8" });

    const add = run("codex", "add", "work");
    assert.equal(add.status, 0);
    assert.match(add.stdout, /^Created ~\/\.codex-accounts\/work\.$/m);
    assert.match(add.stdout, /^Log in with: CODEX_HOME=~\/\.codex-accounts\/work codex login$/m);

    const dir = `${home}/.codex-accounts/work`;
    assert.equal(readFileSync(`${dir}/config.toml`, "utf8"), 'model = "gpt-5"\n', "the config is linked");
    assert.ok(lstatSync(`${dir}/sessions`).isSymbolicLink(), "the shared session history is a link");
    assert.equal(readlinkSync(`${dir}/sessions`), `${home}/.codex/sessions`);
    assert.ok(lstatSync(`${dir}/archived_sessions`).isSymbolicLink());
    assert.ok(lstatSync(`${dir}/history.jsonl`).isSymbolicLink(), "history is created and shared");
    assert.equal(existsSync(`${dir}/auth.json`), false, "the login is not shared");
    assert.equal(existsSync(`${dir}/state.sqlite`), false, "machine state stays behind");
    assert.equal(existsSync(`${dir}/.tmp`), false);

    assert.equal(run("codex", "add", "work").status, 3, "an existing account folder is refused");
    assert.equal(run("codex", "add", "bad name").status, 2);
    assert.equal(run("codex", "add", "default").status, 2);
    assert.equal(run("codex", "add", "codex").status, 2, "codex is now a cca command");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca codex use writes codex-current, refusing a bad name with 2 and a missing account with 3", () => {
  const home = towerHome("codex-use-");
  try {
    mkdirSync(`${home}/.codex-accounts/work`, { recursive: true });
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const use = (...args) => spawnSync("sh", [cca, "codex", "use", ...args], { env, encoding: "utf8" });

    const chosen = use("work");
    assert.equal(chosen.status, 0);
    assert.equal(chosen.stdout.trim(), "work");
    assert.equal(readFileSync(`${home}/state/herdr-tower/codex-current`, "utf8").trim(), "work");
    assert.match(spawnSync("sh", [cca, "--porcelain"], { env, encoding: "utf8" }).stdout, /^Y\twork$/m);

    assert.equal(use("default").status, 0);
    assert.equal(readFileSync(`${home}/state/herdr-tower/codex-current`, "utf8").trim(), "default");

    const missing = use("nope");
    assert.equal(missing.status, 3);
    assert.equal(missing.stderr.trim(), "cca: No Codex account nope.");
    const bad = use("bad name");
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr.trim(), "cca: Use letters, digits, - or _.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca prints each Codex home's X, V and Q lines with the login from auth.json", () => {
  const home = towerHome("codex-porcelain-");
  try {
    const day = `${home}/.codex/sessions/2026/11/09`;
    mkdirSync(day, { recursive: true });
    writeFileSync(`${day}/rollout-x.jsonl`, `${codexEvent}\n`);
    const token = `h.${Buffer.from(JSON.stringify({ email: "me@x" })).toString("base64url")}.s`;
    writeFileSync(`${home}/.codex/auth.json`, JSON.stringify({ tokens: { id_token: token } }));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";

    const add = spawnSync("sh", [cca, "--porcelain-add-codex", "work"], { env, encoding: "utf8" });
    assert.equal(add.status, 0);
    assert.equal(add.stdout.trim(), `${home}/.codex-accounts/work`);
    writeFileSync(`${home}/.codex-accounts/work/auth.json`,
      JSON.stringify({ tokens: { id_token: `h.${Buffer.from(JSON.stringify({ email: "work@x" })).toString("base64url")}.s` } }));

    const out = execFileSync("sh", [cca, "--porcelain"], { env }).toString();
    assert.match(out, /^Y\tdefault$/m);
    assert.match(out, /^X\tdefault\tme@x$/m);
    assert.match(out, /^X\twork\twork@x$/m);
    assert.match(out, /^V\tdefault\t33\t1794208378\t5\t1794795178$/m);
    assert.match(out, /^Q\tdefault\tChatGPT Plus$/m);
    assert.match(out, /^V\twork\t33\t1794208378\t5\t1794795178$/m);
    assert.match(out, /^Q\twork\tChatGPT Plus$/m);

    assert.equal(emailOf(`${home}/.codex`), "me@x");
    const email = spawnSync(process.execPath, [codexUsage, "--email", `${home}/.codex`], { encoding: "utf8" });
    assert.equal(email.status, 0);
    assert.equal(email.stdout.trim(), "me@x");
    const none = spawnSync(process.execPath, [codexUsage, "--email", `${home}/missing`], { encoding: "utf8" });
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cca's shell hook defines codex() beside claude() and reads codex-current", () => {
  const env = { ...process.env, SHELL: "/bin/sh" };
  const out = execFileSync("sh", ["mods/fm-staff/cca", "shell-init"], { env }).toString();
  assert.match(out, /^claude\(\) \{/m, "the Claude hook stays");
  assert.match(out, /^codex\(\) \{/m);
  assert.match(out, /herdr-tower\/codex-current/);
  assert.match(out, /CODEX_HOME="\$HOME\/\.codex-accounts\/\$_cca_codex" command codex "\$@"/);
});

test("a default model id that is no longer in models.json falls back to default", () => {
  const home = towerHome("current-gone-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const current = () => spawnSync("sh", [cca, "current"], { env, encoding: "utf8" }).stdout.trim();
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([{ id: "gpt", command: "claude-gpt" }]));
    writeFileSync(`${home}/state/herdr-tower/current`, "gpt\n");
    assert.equal(current(), "gpt");
    rmSync(`${home}/state/herdr-tower/models.json`);
    assert.equal(current(), "default");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("models.mjs keeps valid entries and skips invalid ones individually", () => {
  const home = mkdtempSync(join(tmpdir(), "models-parse-"));
  try {
    mkdirSync(join(home, ".claude-accounts", "work"), { recursive: true });
    const text = JSON.stringify([
      { id: "gpt", label: "Codex", command: "claude-gpt", resume: "--resume {id}",
        detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
      { id: "Bad Id", command: "x" },
      { id: "default", command: "x" },
      { id: "share", command: "x" },
      { id: "gpt", command: "duplicate" },
      { id: "gemini" },
      { id: "grok", command: "grok\nx" },
      { id: "work", command: "x" },
      { id: "-x", command: "x" },
      "nope",
      { id: "mine", command: " mine ", label: " ", usage: "codex-rollout ~/.codex", resume: "", detect: "BAD" },
      { id: "tabbed", command: "x", label: "Two\tLines\nHere" },
    ]);
    const models = parseModels(text, { home });
    assert.deepEqual(models.map((m) => m.id), ["gpt", "mine", "tabbed"]);
    assert.equal(models[0].command, "claude-gpt");
    assert.equal(models[0].label, "Codex");
    assert.equal(models[0].resume, "--resume {id}");
    assert.equal(models[0].detect, "ANTHROPIC_BASE_URL=http://127.0.0.1:8317");
    assert.equal(models[1].command, "mine");
    assert.equal(models[1].label, undefined);
    assert.equal(models[1].resume, undefined);
    assert.equal(models[1].detect, undefined);
    assert.equal(models[2].label, undefined, "a tab or newline would break the porcelain L line");
    assert.deepEqual(parseModels("{bad", { home }), []);
    assert.deepEqual(parseModels('{"id":"x"}', { home }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a model id is its label lower-cased with spaces as dashes", () => {
  assert.equal(slug("My Grok"), "my-grok");
  assert.equal(slug("Gemini 2.5!"), "gemini-25");
  assert.equal(slug("Codex"), "codex");
  assert.equal(slug("!!"), "");
});

test("the first model whose detect line or CCA_ACCOUNT appears in the pane env wins", () => {
  const models = [
    { id: "codex", detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
    { id: "gemini", detect: "GEMINI_HOME=/x" },
  ];
  assert.equal(matchEnv(models, ["/usr/bin/claude ANTHROPIC_BASE_URL=http://127.0.0.1:8317 HOME=/x"]), "codex");
  assert.equal(matchEnv(models, ["CCA_ACCOUNT=gemini"]), "gemini");
  assert.equal(matchEnv(models, ["CCA_ACCOUNT=other", "HOME=/x"]), null);
  assert.equal(matchEnv(models, []), null);
  assert.equal(matchEnv([{ id: "a", detect: "X=1" }, { id: "b", detect: "X=2" }], ["X=2", "X=1"]), "a");
});

test("a usage line's five tab fields are read, blanks and all", () => {
  assert.deepEqual(parseUsage("33\t1794208378\t5\t1794795178\tplus\n"),
    { fiveUsed: "33", fiveReset: "1794208378", sevenUsed: "5", sevenReset: "1794795178", plan: "plus" });
  assert.deepEqual(parseUsage("7\t\t\t\tsolo"),
    { fiveUsed: "7", fiveReset: "", sevenUsed: "", sevenReset: "", plan: "solo" });
  assert.equal(parseUsage(""), null);
  assert.equal(parseUsage("\n\t\t\t\t\n"), null);
});

test("the codex-rollout usage word points at the bundled reader", () => {
  assert.equal(usageCommand("codex-rollout ~/.codex", "/mods/x", "/home/u"),
    `'${process.execPath}' '/mods/x/codex-usage.mjs' '/home/u/.codex'`);
  assert.equal(usageCommand("printf hi", "/mods/x", "/home/u"), "printf hi");
});

test("cca lists the models file's entries with their usage and label, the labels file's label last", () => {
  const home = towerHome("models-porcelain-");
  try {
    mkdirSync(`${home}/bin`);
    const ps = `${home}/bin/ps`;
    writeFileSync(ps, "#!/bin/sh\nprintf '%s\\n' '/usr/bin/claude CCA_ACCOUNT=gpt HOME=/x'\n");
    chmodSync(ps, 0o755);
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([
      { id: "gpt", label: "Codex", command: "claude-gpt", resume: "--resume {id}",
        usage: "printf '33\\t1794208378\\t5\\t1794795178\\tplus\\n'",
        detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
      { id: "gemini", label: "Gemini", command: "gemini" },
    ]));
    writeFileSync(`${home}/state/herdr-tower/labels`, "gpt\tMy Codex\n");
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state`, CCA_PS: ps };
    const r = spawnSync("sh", ["mods/fm-staff/cca", "--porcelain", "12345"], { env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^C\tgpt$/m);
    assert.match(r.stdout, /^M\tgpt\tclaude-gpt\t1$/m);
    assert.match(r.stdout, /^L\tgpt\tCodex$/m, "the file's label reaches the popup");
    assert.match(r.stdout, /^L\tgpt\tMy Codex$/m);
    assert.match(r.stdout, /^U\tgpt\t33\t1794208378\t5\t1794795178\t\t$/m);
    assert.match(r.stdout, /^P\tgpt\tChatGPT Plus$/m);
    assert.match(r.stdout, /^M\tgemini\tgemini\t0$/m);
    assert.match(r.stdout, /^L\tgemini\tGemini$/m);
    assert.doesNotMatch(r.stdout, /^U\tgemini/m);
    assert.doesNotMatch(r.stdout, /^P\tgemini/m);
    assert.ok(r.stdout.indexOf("L\tgpt\tCodex") < r.stdout.indexOf("L\tgpt\tMy Codex"),
      "main.js keeps the last L, so the labels file's rename wins over the file's label");
    assert.deepEqual(r.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[0]),
      ["C", "D", "A", "M", "L", "U", "P", "M", "L", "L"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a codex-rollout usage word reads codex-usage.mjs under the temp HOME", () => {
  const home = towerHome("models-rollout-");
  try {
    const day = `${home}/.codex/sessions/2026/11/09`;
    mkdirSync(day, { recursive: true });
    writeFileSync(`${day}/rollout-x.jsonl`, `${codexEvent}\n`);
    writeFileSync(`${home}/state/herdr-tower/models.json`, JSON.stringify([
      { id: "local-codex", command: "claude-gpt", usage: "codex-rollout ~/.codex" },
    ]));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const out = execFileSync("sh", ["mods/fm-staff/cca", "--porcelain"], { env }).toString();
    assert.match(out, /^M\tlocal-codex\tclaude-gpt\t0$/m);
    assert.match(out, /^U\tlocal-codex\t33\t1794208378\t5\t1794795178\t\t$/m);
    assert.match(out, /^P\tlocal-codex\tChatGPT Plus$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing or broken models file adds no model lines and still exits 0", () => {
  const home = towerHome("models-none-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const run = () => spawnSync("sh", ["mods/fm-staff/cca", "--porcelain"], { env, encoding: "utf8" });
    let r = run();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /^M\t/m);
    writeFileSync(`${home}/state/herdr-tower/models.json`, "{broken");
    r = run();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /^M\t/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--porcelain-add-model writes the entry and refuses bad ones", () => {
  const home = towerHome("models-add-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const add = (...args) => spawnSync("sh", [cca, "--porcelain-add-model", ...args], { env, encoding: "utf8" });
    const first = add("My Grok", "grok --x");
    assert.equal(first.status, 0);
    assert.equal(first.stdout.trim(), "my-grok");
    const file = `${home}/state/herdr-tower/models.json`;
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")),
      [{ id: "my-grok", label: "My Grok", command: "grok --x" }]);
    const duplicate = add("My Grok", "grok --x");
    assert.equal(duplicate.status, 2);
    assert.doesNotMatch(duplicate.stderr.trim(), /\.$/, "a refusal is one line without a full stop");
    assert.equal(add("default", "x").status, 2);
    assert.equal(add("share", "x").status, 2);
    assert.equal(add("Bad", "one\ntwo").status, 2);
    assert.equal(add("No command", "").status, 2);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1);

    const account = spawnSync("sh", [cca, "add", "my-grok"], { env, encoding: "utf8" });
    assert.equal(account.status, 2);
    assert.match(account.stderr, /my-grok is a model/);

    const rename = spawnSync("sh", [cca, "--porcelain-rename", "my-grok", "Grok"], { env, encoding: "utf8" });
    assert.equal(rename.status, 0);
    assert.match(readFileSync(`${home}/state/herdr-tower/labels`, "utf8"), /^my-grok\tGrok$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("adding a codex command stores the codex-rollout usage, another command does not", () => {
  const home = towerHome("models-codex-");
  try {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state` };
    const cca = "mods/fm-staff/cca";
    const add = (...args) => spawnSync("sh", [cca, "--porcelain-add-model", ...args], { env, encoding: "utf8" });
    assert.equal(add("Codex", "codex").status, 0);
    assert.equal(add("Local Codex", "/usr/local/bin/codex --x").status, 0);
    assert.equal(add("GPT", "claude-gpt").status, 0);
    const entries = JSON.parse(readFileSync(`${home}/state/herdr-tower/models.json`, "utf8"));
    assert.deepEqual(entries.map((m) => [m.id, m.usage]), [
      ["codex", "codex-rollout ~/.codex"],
      ["local-codex", "codex-rollout ~/.codex"],
      ["gpt", undefined],
    ]);
    assert.equal(defaultUsage("codex"), "codex-rollout ~/.codex");
    assert.equal(defaultUsage("bin/codex --full-auto"), "codex-rollout ~/.codex");
    assert.equal(defaultUsage("codex-cli"), null);
    assert.equal(defaultUsage("claude-gpt"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ps -E shows no environment in the test sandbox, so CCA_PS points at a stub printing the pane's line.
const paneOut = (lineOf, models) => {
  const home = mkdtempSync(join(tmpdir(), "pane-"));
  try {
    mkdirSync(`${home}/state/herdr-tower/usage`, { recursive: true });
    writeFileSync(`${home}/state/herdr-tower/usage/.api-fetch`, "");
    mkdirSync(`${home}/.claude-accounts/work`, { recursive: true });
    mkdirSync(`${home}/bin`);
    if (models !== undefined) writeFileSync(`${home}/state/herdr-tower/models.json`, models);
    const ps = `${home}/bin/ps`;
    writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' "${lineOf(home)}"\n`);
    chmodSync(ps, 0o755);
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: `${home}/state`, CCA_PS: ps };
    return execFileSync("sh", ["mods/fm-staff/cca", "--porcelain", "12345"], { env })
      .toString().split("\n")[0];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("cca reads a pane whose environment matches a model's detect as that model", () => {
  const models = JSON.stringify([
    { id: "gpt", command: "claude-gpt", detect: "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" },
  ]);
  assert.equal(paneOut(() => "/usr/bin/claude ANTHROPIC_BASE_URL=http://127.0.0.1:8317 HOME=/x", models), "C\tgpt");
});

test("cca reads CCA_ACCOUNT=<model id> as that model, over the pane's config dir too", () => {
  const models = JSON.stringify([{ id: "gemini", command: "gemini" }]);
  assert.equal(paneOut(() => "/usr/bin/claude CCA_ACCOUNT=gemini HOME=/x", models), "C\tgemini");
  assert.equal(paneOut((home) => `/usr/bin/claude CCA_ACCOUNT=gemini CLAUDE_CONFIG_DIR=${home}/.claude-accounts/work HOME=/x`, models),
    "C\tgemini");
});

test("cca names the current account from the pane's config dir", () => {
  assert.equal(paneOut((home) => `/usr/bin/claude CCA_ACCOUNT=work CLAUDE_CONFIG_DIR=${home}/.claude-accounts/work HOME=/x`),
    "C\twork");
});

test("cca reads a pane without markers as the default account", () => {
  assert.equal(paneOut(() => "/usr/bin/claude HOME=/x"), "C\tdefault");
});

test("the Codex usage reads the last event with a window and skips a cut line", () => {
  const line = (payload) => JSON.stringify({ type: "event_msg", payload });
  const text = [
    '{"type":"event_msg","payload":{"rate_', // the tail read can start mid-line
    line({ rate_limits: { primary: { used_percent: 1, resets_at: 10 }, secondary: null, plan_type: "plus" } }),
    line({ rate_limits: null }),
    codexEvent,
    line({ rate_limits: { primary: null, secondary: null, plan_type: "plus" } }),
  ].join("\n");
  assert.deepEqual(rateLimitsOf(text),
    { five: { used: 33, resets_at: 1794208378 }, seven: { used: 5, resets_at: 1794795178 }, plan: "plus" });
  assert.deepEqual(rateLimitsOf(line({ rate_limits: { secondary: { used_percent: 4.5 } } })),
    { five: null, seven: { used: 4.5, resets_at: null }, plan: null });
  assert.equal(rateLimitsOf(line({ rate_limits: null })), null);
  assert.equal(rateLimitsOf('{"type":"event_msg","payload":{"rate_'), null, "a cut line is skipped");
  assert.equal(rateLimitsOf(""), null);
});

test("codex-usage prints the rollout's five fields, and nothing when there is no data", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-"));
  try {
    const day = join(home, "sessions", "2026", "11", "09");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-x.jsonl"), `${codexEvent}\n`);
    const run = spawnSync(process.execPath, [codexUsage, home], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "33\t1794208378\t5\t1794795178\tplus\n");

    const empty = mkdtempSync(join(tmpdir(), "codex-empty-"));
    try {
      mkdirSync(join(empty, "sessions"), { recursive: true });
      const none = spawnSync(process.execPath, [codexUsage, empty], { encoding: "utf8" });
      assert.equal(none.status, 0);
      assert.equal(none.stdout, "");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The shape /api/oauth/usage answered for an Ultra and a Max account on 2026-11-06, trimmed to the fields read.
test("the Fable week is read from the usage endpoint's weekly_scoped row", () => {
  const ultra = { five_hour: null, seven_day: { utilization: 9.0, resets_at: "2026-11-12T17:59:59.698736+00:00" },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: 9, severity: "normal", resets_at: "2026-11-12T17:59:59.698736+00:00", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: "2026-11-12T18:00:00+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ] };
  assert.deepEqual(fableOf(ultra), { used: 0, resets_at: Date.parse("2026-11-12T18:00:00Z") / 1000 });
  const max = { limits: [
    { kind: "session", group: "session", percent: 4, resets_at: "2026-11-06T09:49:59.879011+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 37, resets_at: "bad", scope: { model: { display_name: "fable" } } },
  ] };
  assert.deepEqual(fableOf(max), { used: 37, resets_at: null });
  assert.equal(fableOf({ limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Opus" } } }] }), null);
  assert.equal(fableOf({}), null);
});

test("usage-api exits 1 on unreadable credentials, also from a path a file URL would escape", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage api "));
  const copy = join(dir, "usage-api.mjs");
  copyFileSync(new URL("../mods/fm-staff/usage-api.mjs", import.meta.url), copy);
  try {
    const run = spawnSync(process.execPath, [copy], { input: "{bad", encoding: "utf8" });
    assert.equal(run.status, 1, "a silent exit 0 would let cca overwrite the last record with nothing");
    assert.equal(run.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom command may keep the id codex, since only account folder names are cca commands", () => {
  const home = mkdtempSync(join(tmpdir(), "cca-models-codex-"));
  try {
    const text = JSON.stringify([{ id: "codex", label: "Codex", command: "claude-gpt" }]);
    assert.deepEqual(parseModels(text, { home }).map((m) => m.id), ["codex"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const KNOWN_AGENTS = [
  { key: "claude", name: "Claude", run: ["claude"], installed: true },
  { key: "codex", name: "Codex", run: ["codex"], installed: true },
  { key: "gemini", name: "Gemini", run: ["gemini", "--yolo"], installed: true },
  { key: "orca", name: "Orca", run: ["orca"], installed: false },
];

test("installed agents beyond Claude and Codex keep their own group and launch in a new pane", () => {
  const rows = staffRowsOf(staffSample(), { agents: KNOWN_AGENTS });
  assert.deepEqual(rows.filter((r) => r.kind === "group").map((r) => r.title),
    ["Claude", "Codex", "Other agents", "Custom commands", "Start command"]);
  const gemini = rows.find((r) => r.id === "agent:gemini");
  assert.equal(gemini.display, "Gemini");
  assert.equal(gemini.contract, "Launches in a new pane");
  assert.equal(gemini.untracked, true, "no usage data, so the budget cells say so");
  assert.deepEqual(gemini.actions.map((a) => a.label), ["new pane"]);
  assert.equal(gemini.focus, true, "the row takes the same keyboard as the others");
  assert.equal(rows.some((r) => r.id === "agent:orca"), false, "an agent that is not installed is not listed");
  assert.equal(rows.some((r) => r.id === "agent:claude"), false, "Claude and Codex own the groups above");
  assert.equal(rows.some((r) => r.id === "agent:codex"), false);
  assert.deepEqual(otherAgents(null), []);
});

test("an agent row opens its run command in a new pane", () => {
  const v = Object.create(ClaudeAccounts.prototype);
  globalThis.herdrRuns = [];
  try {
    v.openOtherAgent({ key: "gemini", run: ["gemini", "--yolo"] });
    assert.deepEqual(globalThis.herdrRuns.at(-1),
      ["pane.split", { direction: "right", argv: ["gemini", "--yolo"] }]);
    v.openOtherAgent({ key: "broken", run: [] });
    assert.equal(globalThis.herdrRuns.length, 1, "a row with no run command starts nothing");
  } finally {
    globalThis.herdrRuns = undefined;
  }
});

test("the screen renders with nothing in Herdr and with fm.squad null", () => {
  try {
    for (const state of [{}, { shared: { "fm.squad": null } }, { shared: { "fm.squad": {} } }]) {
      globalThis.herdrState = state;
      const v = Object.create(ClaudeAccounts.prototype);
      Object.assign(v, {
        role: "screen", accounts: [{ name: "default", email: "", usage: null }], agents: KNOWN_AGENTS,
        codex: null, current: "default", globalDefault: "default", session: null, launch: "claude",
        at: 0, keyboard: false, rename: null, addEdit: null, launchEdit: null,
        readError: null, actionError: null, renameError: null, launchError: null,
        handle: { focus() {}, is_focused: () => false },
      });
      assert.doesNotThrow(() => v.render({ notify() {}, spawn() {}, timer: { after() {}, every() {} } }),
        "no accounts read, no usage, no agents from Herdr");
    }
  } finally {
    globalThis.herdrState = undefined;
  }
});
