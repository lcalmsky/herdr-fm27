import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCAN = new URL("../mods/fm-squad/scan.sh", import.meta.url);
// scan.sh is python3 fed through a heredoc; its functions are loaded without the closing main() call.
const PYTHON = readFileSync(SCAN, "utf8").split("<<'PY'\n")[1].split("\nPY\n")[0].split("\ntry:\n    main()")[0];

function sandbox(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "fm-squad-scan-"));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  mkdirSync(temp, { recursive: true });
  const put = (path, body) => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  // ps/lsof are stubbed so a scan never looks at the machine's real processes.
  const stub = (name, body) => {
    const file = join(root, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const quiet = stub("quiet.sh", "");
  const env = {
    ...process.env, HOME: home, TMPDIR: temp, CLAUDE_CONFIG_DIR: "",
    PULSE_PS: quiet, PULSE_LSOF: quiet, ...extraEnv,
  };
  const call = (expression) => JSON.parse(execFileSync("python3", ["-c", `${PYTHON}\nprint(json.dumps(${expression}, ensure_ascii=False))`], { env, encoding: "utf8" }));
  const scan = () => execFileSync("sh", [SCAN.pathname], { env, encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line));
  return { root, home, temp, put, stub, env, call, scan, done: () => rmSync(root, { recursive: true, force: true }) };
}

const user = (content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A ps stub that answers both the process listing and `ps eww`, plus an lsof stub, from files
// inside the sandbox: processes is `["<pid> <tty> <etime> <command>"]`, envs is pid -> "VAR=value ...".
function scanStub(box, { processes = [], envs = {}, cwds = {} }) {
  const list = box.put("ps/list.txt", processes.length ? `${processes.join("\n")}\n` : "");
  const envLines = Object.entries(envs).map(([pid, vars]) => `  ${pid} ${vars}`);
  const envFile = box.put("ps/env.txt", envLines.length ? `${envLines.join("\n")}\n` : "");
  const lsofText = Object.entries(cwds).map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}\n`).join("");
  const lsofFile = box.put("lsof/out.txt", lsofText);
  box.env.PULSE_PS = box.stub("ps.sh", `case "$*" in *eww*) cat ${JSON.stringify(envFile)} ;; *) cat ${JSON.stringify(list)} ;; esac`);
  box.env.PULSE_LSOF = box.stub("lsof.sh", `cat ${JSON.stringify(lsofFile)}`);
}

const sessionsOf = (lines) => lines.filter((line) => line.t === "s");
const codexRollout = (box, records, day = "2999/12/31") => box.put(
  `.codex/sessions/${day}/rollout-2026-11-09T00-00-00-11111111-2222-3333-4444-555555555555.jsonl`,
  records.map((record) => JSON.stringify(record)).join("\n"));

test("a garbled rolling-delivery file gives no objectives and never stops the scan", () => {
  const box = sandbox();
  try {
    box.put(".claude/state/rolling-delivery/active-programs.json", { programs: [1, "x", null,
      { objective: "WEB-1313 고도화 에픽: 부재 판단을 정한다 (PRD prd/x.md 의 P0). 조사 후 진행", updated_at: "2026-11-06" },
      { objective: "WEB-1313 예전 목표", updated_at: "2026-11-01" }] });
    assert.deepEqual(box.call("rd_objectives()"), { "WEB-1313": "고도화 에픽: 부재 판단을 정한다" });
    box.put(".claude/state/rolling-delivery/active-programs.json", { programs: { a: 1 } });
    assert.deepEqual(box.call("rd_objectives()"), {});
    box.put(".claude/state/rolling-delivery/active-programs.json", "{not json");
    assert.deepEqual(box.call("rd_objectives()"), {});
    const meta = box.scan().at(-1);
    assert.equal(meta.t, "meta");
    assert.equal(meta.error, null);
    assert.deepEqual(meta.objectives, {});
  } finally {
    box.done();
  }
});

test("the identity takes the first real prompt, the handoff H1 it names, its round and a pasted H1", () => {
  const box = sandbox();
  try {
    const handoff = box.put(".claude/handoff/WEB-1435.md", "intro\n# WEB-1435 실행 핸드오프\nbody\n");
    const slash = box.put("t/slash.jsonl", [
      user("ignored", { isMeta: true }),
      user("<local-command-stdout>x</local-command-stdout>"),
      user(`<command-message>relay</command-message><command-name>/relay</command-name><command-args>${handoff} 3회차 이어서</command-args>`),
    ].join("\n"));
    const slashId = box.call(`session_identity(${JSON.stringify(slash)}, "s1", "/x")`);
    assert.equal(slashId.handoff, "WEB-1435 실행 핸드오프");
    assert.equal(slashId.round, 3);
    assert.ok(slashId.firstPrompt.startsWith(handoff));

    const pasted = box.put("t/pasted.jsonl", user([{ type: "text", text: "<pasted_content id=\"a\">\n# 붙여넣은 브리프\n본문\n</pasted_content> 이거 해줘" }]));
    assert.equal(box.call(`session_identity(${JSON.stringify(pasted)}, "s2", "/x")`).paste, "붙여넣은 브리프");
    assert.equal(box.call(`first_prompt(${JSON.stringify(join(box.home, "missing.jsonl"))})`), null);
  } finally {
    box.done();
  }
});

test("a Maveyyo session reads its topic from thread memory, else the received event, and survives garbled state", () => {
  const box = sandbox();
  try {
    const state = ".claude/state/maveyyo-bot";
    const withMemory = join(box.home, state, "sessions/C0EXAMPLE01-1793691052_993259");
    box.put(`${state}/threads/C0EXAMPLE01-1793691052_993259.json`, { lane: "prod", session: "garbled" });
    box.put(`${state}/memory/threads/C0EXAMPLE01-1793691052.993259.md`, "# 기억\n- 질문: 영업시간이 언제인가요?\n");
    assert.deepEqual(box.call(`maveyyo_topic(${JSON.stringify(withMemory)})`),
      { channel: "C0EXAMPLE01", threadAt: 1793691052000, lane: "prod", label: null, topic: "영업시간이 언제인가요?" });

    const fromEvent = join(box.home, state, "sessions/C0EXAMPLE02-1793000000_111111");
    box.put(`${state}/events.ndjson`, [
      '["received", "1793000000.111111"]',
      JSON.stringify({ type: "received", thread_ts: "1793000000.111111", text: "비밀번호를 잊어버렸어요" }),
    ].join("\n"));
    assert.equal(box.call(`maveyyo_topic(${JSON.stringify(fromEvent)})`).topic, "비밀번호를 잊어버렸어요");
    assert.equal(box.call(`maveyyo_topic("/x/not-a-thread")`), null);
  } finally {
    box.done();
  }
});

test("the identity cache is final only once the prompt and any Maveyyo topic are known", () => {
  const box = sandbox();
  try {
    const transcript = box.put("t/mv.jsonl", user("스레드 답변해 줘"));
    const cwd = join(box.home, ".claude/state/maveyyo-bot/sessions/C0EXAMPLE01-1790000000_000001");
    const cache = join(box.temp, "herdr-pulse", "identity-mv1.json");
    box.call(`session_identity(${JSON.stringify(transcript)}, "mv1", ${JSON.stringify(cwd)})`);
    assert.equal(JSON.parse(readFileSync(cache, "utf8")).final, false, "no topic yet, so the next scan reads again");

    box.put(".claude/state/maveyyo-bot/memory/threads/C0EXAMPLE01-1790000000.000001.md", "- 원글: 로그인이 안 돼요\n");
    box.call(`session_identity(${JSON.stringify(transcript)}, "mv1", ${JSON.stringify(cwd)})`);
    assert.equal(JSON.parse(readFileSync(cache, "utf8")).final, true);

    box.put("t/mv.jsonl", user("바뀐 프롬프트"));
    assert.equal(box.call(`session_identity(${JSON.stringify(transcript)}, "mv1", ${JSON.stringify(cwd)})`).firstPrompt, "스레드 답변해 줘",
      "a final identity is served from the cache");
  } finally {
    box.done();
  }
});

test("an idle spare bg worker is no session, but a spare that took work and a plain idle session are", () => {
  const box = sandbox();
  try {
    const record = (sessionId, extra) => ({ pid: process.pid, sessionId, cwd: box.home, entrypoint: "cli", kind: "bg", ...extra });
    box.put(".claude/sessions/1.json", record("spare-idle", { spare: true, status: "idle" }));
    box.put(".claude/sessions/2.json", record("spare-busy", { spare: true, status: "busy" }));
    box.put(".claude/sessions/3.json", record("plain-idle", { status: "idle" }));
    const ids = box.scan().filter((line) => line.t === "s").map((line) => line.sessionId).sort();
    assert.deepEqual(ids, ["plain-idle", "spare-busy"]);
  } finally {
    box.done();
  }
});

test("a claude --bg session with no terminal is a claude-bg card that can be attached", () => {
  const box = sandbox();
  try {
    const sessionId = "e7b86417-1111-2222-3333-444455556666";
    const record = (extra) => ({ pid: process.pid, sessionId, cwd: box.home, entrypoint: "cli", kind: "bg", status: "idle", ...extra });
    box.put(".claude/sessions/1.json", record({}));
    let [card] = sessionsOf(box.scan());
    assert.equal(card.where.kind, "claude-bg");
    assert.equal(card.where.attachId, "e7b86417");
    assert.equal(card.where.paneId, null);

    scanStub(box, { envs: { [process.pid]: "HC_TERMINAL_ID=t1fb HC_TERMINAL_SOCKET=/tmp/hc.sock" } });
    [card] = sessionsOf(box.scan());
    assert.equal(card.where.kind, "claude-bg", "terminal variables inherited from the daemon's starter are ignored");

    scanStub(box, {
      processes: ["4242 ttys001 01:00 /usr/local/bin/claude attach e7b86417"],
      envs: { 4242: "HERDR_PANE_ID=p1" },
    });
    [card] = sessionsOf(box.scan());
    assert.equal(card.where.kind, "claude-bg");
    assert.equal(card.where.paneId, "p1");

    scanStub(box, {
      processes: ["4244 ?? 01:00 claude attach e7b86417"],
      envs: { 4244: "HERDR_PANE_ID=p2" },
    });
    [card] = sessionsOf(box.scan());
    assert.equal(card.where.paneId, null, "an attach process without a terminal is no pane");

    scanStub(box, {
      processes: ["4243 ttys002 01:00 claude attach mv-bg"],
      envs: { 4243: "HC_TERMINAL_ID=t1gj" },
    });
    box.put(".claude/sessions/1.json", record({ name: "mv-bg" }));
    [card] = sessionsOf(box.scan());
    assert.equal(card.where.terminalId, "t1gj", "a Herdr app pane reports its terminal id, found here by the session name");
    assert.equal(card.where.paneId, null);

    box.put(".claude/sessions/1.json", record({ kind: "interactive" }));
    [card] = sessionsOf(box.scan());
    assert.equal(card.where.kind, null);
  } finally {
    box.done();
  }
});

test("a Claude session says it is claude and changes in no other way", () => {
  const box = sandbox();
  try {
    box.put(".claude/sessions/1.json", {
      pid: process.pid, sessionId: "plain-idle", cwd: box.home, entrypoint: "cli", name: "my job", status: "idle",
    });
    const [session] = sessionsOf(box.scan());
    assert.equal(session.agent, "claude");
    assert.equal(session.sessionId, "plain-idle");
    assert.equal(session.name, "my job");
    assert.equal(session.status, "idle");
    assert.deepEqual(session.background, { shells: 0, agents: 0, monitors: 0, total: 0 });
  } finally {
    box.done();
  }
});

test("a native codex process is a busy card while its last rollout turn is open", () => {
  const box = sandbox();
  try {
    const cwd = join(box.home, "work/repo");
    mkdirSync(cwd, { recursive: true });
    codexRollout(box, [
      { timestamp: "2026-11-09T00:00:00Z", type: "session_meta",
        payload: { session_id: "11111111-2222-3333-4444-555555555555", cwd } },
      { timestamp: "2026-11-09T00:00:01Z", type: "event_msg", payload: {
        type: "user_message", message: "# Files mentioned by the user:\n\n- /a.py\n\n## My request:\nadd tests please" } },
      { timestamp: "2026-11-09T00:00:02Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: "2026-11-09T00:00:03Z", type: "response_item", payload: { type: "function_call", name: "shell" } },
    ]);
    scanStub(box, {
      processes: ["4242 ttys001 01:00 /opt/homebrew/bin/codex"],
      envs: { 4242: "TMUX_PANE=%7 TMUX=/tmp/tmux,1234,0" },
      cwds: { 4242: cwd },
    });
    const sessions = sessionsOf(box.scan());
    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.equal(session.agent, "codex");
    assert.equal(session.status, "busy");
    assert.equal(session.sessionId, "11111111-2222-3333-4444-555555555555");
    assert.equal(session.identity.firstPrompt, "add tests please");
    assert.equal(session.lastPrompt, "add tests please");
    assert.equal(session.currentAction, "shell");
    assert.equal(session.where.kind, "tmux");
    assert.equal(session.where.paneId, "%7");
    assert.equal(session.lastMeaningfulAt, Date.parse("2026-11-09T00:00:03Z"));
    assert.deepEqual(session.background, { shells: 0, agents: 0, monitors: 0, total: 0 });
    assert.deepEqual(session.completed, []);
    assert.equal(session.deadhd, null);
    assert.deepEqual(session.pages, []);
  } finally {
    box.done();
  }
});

test("a closed codex turn is idle with its answer, and an errored one says Error: first", () => {
  const run = (completion) => {
    const box = sandbox();
    const cwd = join(box.home, "work/repo");
    mkdirSync(cwd, { recursive: true });
    codexRollout(box, [
      { timestamp: "2026-11-09T00:00:00Z", type: "session_meta", payload: { id: "sess", cwd } },
      { timestamp: "2026-11-09T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "do it" } },
      { timestamp: "2026-11-09T00:00:02Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: "2026-11-09T00:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", ...completion } },
    ]);
    scanStub(box, { processes: ["4242 ttys001 01:00 /usr/bin/codex"], cwds: { 4242: cwd } });
    const [session] = sessionsOf(box.scan());
    box.done();
    return session;
  };
  const done = run({ last_agent_message: "All done." });
  assert.equal(done.status, "idle");
  assert.equal(done.lastAnswer, "All done.");
  assert.equal(done.sessionId, "sess");
  assert.equal(done.currentAction, null);
  const failed = run({ turn_id: "t1", error: { message: "boom" } });
  assert.equal(failed.lastAnswer, "Error: boom");
});

test("a codex with no rollout is an idle session with a UUID-shaped id, and another folder's rollout is not it", () => {
  const box = sandbox();
  try {
    const cwd = join(box.home, "work/repo");
    const other = join(box.home, "work/other");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(other, { recursive: true });
    scanStub(box, { processes: ["4242 ttys001 01:00 /usr/bin/codex"], cwds: { 4242: cwd } });
    const [first] = sessionsOf(box.scan());
    assert.equal(first.agent, "codex");
    assert.equal(first.status, "idle");
    assert.match(first.sessionId, UUID_RE);
    assert.equal(first.lastAnswer, null);

    codexRollout(box, [
      { timestamp: "2026-11-09T00:00:00Z", type: "session_meta", payload: { session_id: "other-session", cwd: other } },
      { timestamp: "2026-11-09T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "not mine" } },
    ]);
    const [second] = sessionsOf(box.scan());
    assert.equal(second.status, "idle");
    assert.match(second.sessionId, UUID_RE);
    assert.notEqual(second.sessionId, "other-session");
  } finally {
    box.done();
  }
});

test("ChatGPT helpers and codex subcommands are not sessions", () => {
  const box = sandbox();
  try {
    const cwd = join(box.home, "work/repo");
    mkdirSync(cwd, { recursive: true });
    scanStub(box, {
      processes: [
        "5001 ttys001 01:00 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)",
        "5002 ttys001 01:00 /opt/homebrew/bin/codex app-server",
        "5003 ttys001 01:00 /usr/local/bin/codex-code-mode-host",
        "5004 ttys001 01:00 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
        // A server with no terminal is no session, whatever subcommand it runs.
        "5005 ?? 01:00 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c forced_login_method=\"chatgpt\" exec-server --concurrent-requests 32",
        "5006 ?? 01:00 /opt/homebrew/bin/codex",
      ],
      cwds: { 5001: cwd, 5002: cwd, 5003: cwd, 5004: cwd, 5005: cwd, 5006: cwd },
    });
    assert.deepEqual(sessionsOf(box.scan()), []);
  } finally {
    box.done();
  }
});

test("a gemini process reads its jsonl and json chat slots, by folder hash and by projects.json name", () => {
  const box = sandbox();
  try {
    const alpha = join(box.home, "work/alpha");
    const beta = join(box.home, "work/beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    const slot = createHash("sha256").update(alpha).digest("hex");
    box.put(`.gemini/tmp/${slot}/chats/session-alpha.jsonl`, [
      JSON.stringify({ type: "session_metadata", sessionId: "g-alpha", startTime: "2026-11-09T00:00:00Z" }),
      JSON.stringify({ type: "user", id: "1", content: "hello gemini", timestamp: "2026-11-09T00:00:01Z" }),
      JSON.stringify({ type: "message_update" }),
    ].join("\n"));
    box.put(".gemini/projects.json", { [beta]: "beta-slot" });
    box.put(".gemini/tmp/beta-slot/chats/session-beta.json", {
      sessionId: "g-beta",
      startTime: "2026-11-09T00:00:00Z",
      messages: [
        { type: "user", content: "hi there", timestamp: "2026-11-09T00:00:01Z" },
        { type: "gemini", content: [{ text: "all finished" }], timestamp: "2026-11-09T00:00:02Z" },
      ],
    });
    scanStub(box, {
      processes: [
        "6001 ttys001 01:00 /opt/homebrew/bin/gemini",
        "6002 ttys001 01:00 node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js",
      ],
      cwds: { 6001: alpha, 6002: beta },
    });
    const sessions = sessionsOf(box.scan());
    const busy = sessions.find((session) => session.pid === 6001);
    const idle = sessions.find((session) => session.pid === 6002);
    assert.equal(busy.agent, "gemini");
    assert.equal(busy.status, "busy");
    assert.equal(busy.sessionId, "g-alpha");
    assert.equal(busy.lastPrompt, "hello gemini");
    assert.equal(busy.identity.firstPrompt, "hello gemini");
    assert.equal(idle.agent, "gemini");
    assert.equal(idle.status, "idle");
    assert.equal(idle.sessionId, "g-beta");
    assert.equal(idle.lastAnswer, "all finished");
    assert.equal(idle.identity.firstPrompt, "hi there");
  } finally {
    box.done();
  }
});

test("a codex build without user_message events reads the prompt from user response items, past injected context", () => {
  const box = sandbox();
  try {
    const cwd = join(box.home, "work/repo");
    mkdirSync(cwd, { recursive: true });
    const said = (text) => ({ timestamp: "2026-11-09T00:00:01Z", type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    codexRollout(box, [
      { timestamp: "2026-11-09T00:00:00Z", type: "session_meta", payload: { session_id: "sess", cwd } },
      { timestamp: "2026-11-09T00:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      said("# AGENTS.md instructions\n\n<INSTRUCTIONS>defaults</INSTRUCTIONS>"),
      said("<environment_context>cwd</environment_context>"),
      said("first ask"),
      { timestamp: "2026-11-09T00:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "ok" } },
      { timestamp: "2026-11-09T00:00:03Z", type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
      said("second ask"),
    ]);
    scanStub(box, { processes: ["4242 ttys001 01:00 /usr/bin/codex"], cwds: { 4242: cwd } });
    const [session] = sessionsOf(box.scan());
    assert.equal(session.status, "busy");
    assert.equal(session.identity.firstPrompt, "first ask");
    assert.equal(session.lastPrompt, "second ask");
  } finally {
    box.done();
  }
});

test("a codex turn that wrote more than the tail since task_started is still busy, and one closed far back is idle", () => {
  const run = (closed) => {
    const box = sandbox();
    const cwd = join(box.home, "work/repo");
    mkdirSync(cwd, { recursive: true });
    const filler = Array.from({ length: 400 }, (_, i) => ({ timestamp: "2026-11-09T00:00:05Z", type: "response_item",
      payload: { type: "function_call_output", call_id: `c${i}`, output: "x".repeat(1100) } }));
    codexRollout(box, [
      { timestamp: "2026-11-09T00:00:00Z", type: "session_meta", payload: { session_id: "sess", cwd } },
      { timestamp: "2026-11-09T00:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      ...(closed ? [{ timestamp: "2026-11-09T00:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "ok" } }] : []),
      ...filler,
    ]);
    scanStub(box, { processes: ["4242 ttys001 01:00 /usr/bin/codex"], cwds: { 4242: cwd } });
    const [session] = sessionsOf(box.scan());
    box.done();
    return session;
  };
  assert.equal(run(false).status, "busy");
  assert.equal(run(true).status, "idle");
});

test("two codex processes in one folder each take their own rollout", () => {
  const box = sandbox();
  try {
    const cwd = join(box.home, "work/repo");
    mkdirSync(cwd, { recursive: true });
    const rollout = (id) => box.put(`.codex/sessions/2999/12/31/rollout-2026-11-09T00-00-00-${id}.jsonl`,
      JSON.stringify({ timestamp: "2026-11-09T00:00:00Z", type: "session_meta", payload: { session_id: id, cwd } }));
    rollout("aaaaaaaa-0000-0000-0000-000000000001");
    rollout("aaaaaaaa-0000-0000-0000-000000000002");
    scanStub(box, { processes: ["4242 ttys001 01:00 /usr/bin/codex", "4343 ttys001 00:30 /usr/bin/codex"], cwds: { 4242: cwd, 4343: cwd } });
    const ids = sessionsOf(box.scan()).map((session) => session.sessionId).sort();
    assert.deepEqual(ids, ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"]);
  } finally {
    box.done();
  }
});
