// Model and keyboard tests for the fm-squad mod: grouping, sort, stall/snooze, history,
// notices, the Dossier popup and the published fm.squad state. Ported from
// herdr-chiikawa-cards tests/cards.test.mjs, with the character/geometry/strip tests dropped.
// Run: node --import ./tests/stubs/register.mjs --test tests/squad.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import FmSquad, {
  SQUAD_KEY, NOTICE_KEY, NOTICE_ACT_KEY, CMD_KEY, SEL_KEY, NO_PAGE_FLASH, MAX_DONE,
  SCAN_KEY, SCAN_TTL_MS,
  COLUMNS, COLUMN_DROP, INBOX_KINDS, INBOX_EMPTY, visibleColumns,
  stateOf, shapeOf, groundOf, ticketOf, agentKindOf, planStep,
  foldHandoffs, terminalOf, placeOf, slackThreadOf, topicOf, cleanMessage, chosenTitle,
  linksOf, linksMenuHeight, LINKS_W, CHECKLIST_PROMPT, CHECKLIST_QUEUED_PROMPT,
  visitHistory, stepHistory, HISTORY_MAX, nextSettings, TERM_FONT,
  setConfig, getConfig, DEFAULT_CONFIG,
} from "../mods/fm-squad/main.js";
import { shared, setShared } from "../tests/stubs/herdr.mjs";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const CONFIG = {
  jiraBrowse: "https://acme.atlassian.net/browse/",
  slackArchives: "https://acme.slack.com/archives/",
  repos: ["shop"],
};

beforeEach(() => { setConfig(CONFIG); });

function view(sessions, state = {}, extra = {}) {
  globalThis.herdrState = state;
  const v = new FmSquad();
  Object.assign(v, {
    role: "squad",
    sessions, meta: { roots: 1, pages: [], unreadablePages: [] }, seen: [], viewed: [], readReports: [],
    snoozed: {}, since: {}, query: "", expanded: new Set(), stepTop: {}, showAllDone: false, sel: null,
    selIndex: 0, history: { list: [], at: -1 }, navTarget: null, places: {},
    scroll: { scroll_to_item() {} }, handle: { focus() {}, is_focused: () => false },
    published: null, publishedNotice: null, publishedSel: null, agentOrder: null,
    ...extra,
  });
  return v;
}

const session = (id, status, minutesAgo, extra = {}) => ({
  t: "s", sessionId: id, pid: 100 + id.length, status, name: id,
  statusUpdatedAt: NOW - minutesAgo * MIN, lastMeaningfulAt: NOW - 30_000,
  background: { shells: 0, agents: 0, monitors: 0, total: 0 }, where: { kind: "herdr-app" }, ...extra,
});

const press = (v, key, alt = false, shift = false, control = false, keyChar = null) => {
  const calls = { stop: 0, notify: 0 };
  v.key({ key, modifiers: { alt, shift, platform: false, control }, key_char: keyChar, is_held: false }, {
    stop_propagation() { calls.stop += 1; },
    notify() { calls.notify += 1; },
    spawn() {},
    timer: { after() {} },
  });
  return calls;
};

const pressCmd = (v, key) => {
  const calls = { stop: 0, notify: 0 };
  v.key({ key, modifiers: { alt: false, shift: false, platform: true, control: false }, key_char: null, is_held: false }, {
    stop_propagation() { calls.stop += 1; },
    notify() { calls.notify += 1; },
    spawn() {},
    timer: { after() {} },
  });
  return calls;
};

const publishedValue = () => globalThis.herdrShared?.filter(([name]) => name === SQUAD_KEY).at(-1)?.[1] ?? null;

test("groups sessions and sorts touchline and possession oldest first, full time newest first", () => {
  const v = view([
    session("w-new", "busy", 2), session("w-old", "busy", 9),
    session("a-new", "waiting", 1), session("a-old", "waiting", 7),
    session("d-old", "idle", 50), session("d-new", "idle", 5),
  ]);
  const model = v.buildModel(NOW);
  assert.deepEqual(model.attention.map((i) => i.sessionId), ["a-old", "a-new"]);
  assert.deepEqual(model.working.map((i) => i.sessionId), ["w-old", "w-new"]);
  assert.deepEqual(model.done.map((i) => i.sessionId), ["d-new", "d-old"]);
  assert.deepEqual(model.counts, { attention: 2, working: 2, done: 2 });
});

test("a busy session quiet for 10 minutes without background work is a stall until rested", () => {
  const v = view([session("s", "busy", 20, { lastMeaningfulAt: NOW - 11 * MIN })]);
  const [stall] = v.buildModel(NOW).attention;
  assert.equal(stall.bucket, "stall");
  assert.equal(stateOf(stall), "stall");
  v.snoozed.s = NOW + MIN;
  assert.equal(v.buildModel(NOW).working[0].sessionId, "s");
});

test("a live session idle for a day keeps its full-time row, Pulse or Herdr-only", () => {
  const v = view([session("old", "idle", 24 * 60)]);
  assert.deepEqual(v.buildModel(NOW).done.map((i) => i.sessionId), ["old"]);
  const herdrOnly = view([], { agents: [{ address: "t8", pane: "p8", space: "s", space_name: "acme", status: "idle", app: "codex", seq: 41, title: "job",
    program: { name: "codex" }, status_ms: NOW - 24 * 60 * MIN }] });
  assert.equal(herdrOnly.buildModel(NOW).done.length, 1);
});

test("a seen full-time row stays hidden, and a seen Herdr-only agent row stays hidden across a reload", () => {
  const v = view([session("d", "idle", 3)]);
  const [item] = v.buildModel(NOW).done;
  v.seen = [item.ackKey];
  assert.equal(v.buildModel(NOW).done.length, 0);

  const state = { agents: [{ address: "t8", pane: "p8", space: "s", space_name: "acme", status: "idle", app: "codex", seq: 41, title: "job", program: { name: "codex" } }] };
  const first = view([], state);
  const [row] = first.buildModel(NOW).done;
  const reloaded = view([], state);
  reloaded.seen = [row.ackKey];
  assert.equal(reloaded.buildModel(NOW).done.length, 0);
});

test("Herdr agents Pulse doesn't list join the table; Claude Code and matched terminals don't", () => {
  const agent = (address, status, app = "codex") => ({ address, pane: `p-${address}`, space: "s", space_name: "acme", status, app, title: `${address} job`, program: { name: app } });
  const v = view([session("claude", "busy", 4, { pid: 42 })], {
    terminals: [{ address: "t1", state: "live", foreground: { pid: 42 } }],
    agents: [agent("t1", "working", "claude-code"), agent("t2", "blocked"), agent("t3", "working"), agent("t4", "idle"), agent("t5", "blocked", "claude-code")],
  });
  const model = v.buildModel(NOW);
  assert.deepEqual(model.attention.map((i) => i.sessionId), ["agent:t2"]);
  assert.deepEqual(model.working.map((i) => i.sessionId).sort(), ["agent:t3", "claude"]);
  assert.deepEqual(model.done.map((i) => i.sessionId), ["agent:t4"]);
  assert.equal(model.working.find((i) => i.sessionId === "claude").terminal, "t1");
});

test("a native agent reports its kind, and its Herdr-blocked status puts it on the touchline", () => {
  const agent = (address, status, seq = 1) => ({ address, pane: `p-${address}`, space: "s", space_name: "acme", status, app: "codex", seq, title: `${address} job`, program: { name: "codex" } });
  const codex = session("cx", "busy", 2, { agent: "codex", cwd: "/repo/thing", pid: 77 });
  const v = view([codex], { terminals: [{ address: "t7", state: "live", foreground: { pid: 77 } }], agents: [agent("t7", "blocked")] });
  const model = v.buildModel(NOW);
  assert.deepEqual(model.attention.map((item) => item.sessionId), ["cx"]);
  assert.equal(agentKindOf(model.attention[0]), "codex");
  const claude = view([session("cl", "busy", 2, { agent: "claude", pid: 78 })], {
    terminals: [{ address: "t8", state: "live", foreground: { pid: 78 } }],
    agents: [agent("t8", "blocked")],
  });
  assert.deepEqual(claude.buildModel(NOW).working.map((item) => item.sessionId), ["cl"], "Claude sessions keep their own bucket");
  assert.equal(agentKindOf(claude.buildModel(NOW).working[0]), "claude");
});

test("Esc steps back one layer: the search, then the selection, then the pane below", () => {
  const v = view([session("a", "waiting", 3), session("d", "idle", 5)]);
  Object.assign(v, { sel: "d", query: "d" });
  globalThis.herdrRuns = [];
  try {
    press(v, "escape");
    assert.equal(v.query, "", "the first Esc clears the search");
    assert.equal(v.sel, "d", "and keeps the selection");
    press(v, "escape");
    assert.equal(v.selectedItem(v.viewData()), null, "the second Esc clears the selection");
    assert.deepEqual(globalThis.herdrRuns, [], "the pane below waits for the third");
    press(v, "escape");
    assert.deepEqual(globalThis.herdrRuns, [["pane.go", { direction: "down" }]], "the third hands the keyboard down");
  } finally {
    globalThis.herdrRuns = undefined;
  }
});

test("Esc clears the sub-tab group filter before the selection, and publishes Overview", () => {
  const v = view([session("a", "waiting", 3), session("w", "busy", 5)]);
  Object.assign(v, { sel: "w", groupFilter: "working" });
  globalThis.herdrShared = [];
  try {
    press(v, "escape");
    assert.equal(v.groupFilter, null, "the first Esc clears the filter");
    assert.equal(v.sel, "w", "and keeps the selection");
    assert.deepEqual(v.viewData(NOW).groups.map((group) => group.id), ["attention", "working", "done"]);
    v.publish(v.viewData(NOW), false);
    assert.equal(publishedValue().groupFilter, null, "the sub bar can show Overview active again");
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("Esc with search text clears only the search, leaving the group filter", () => {
  const v = view([session("a", "waiting", 3), session("d", "idle", 5)]);
  Object.assign(v, { sel: "d", query: "d", groupFilter: "done" });
  press(v, "escape");
  assert.equal(v.query, "", "the search is cleared first");
  assert.equal(v.groupFilter, "done", "the filter waits for the next Esc");
  assert.equal(v.sel, "d");
});

test("left and right move between rows and wrap; alt jumps to the ends", () => {
  const v = view([session("a", "waiting", 3), session("b", "busy", 5), session("c", "busy", 4)]);
  Object.assign(v, { sel: "a" });
  press(v, "right"); assert.equal(v.sel, "b");
  press(v, "right"); assert.equal(v.sel, "c");
  press(v, "right"); assert.equal(v.sel, "a");
  press(v, "left"); assert.equal(v.sel, "c");
  press(v, "left", true); assert.equal(v.sel, "a");
  press(v, "right", true); assert.equal(v.sel, "c");
});

test("left and right cross the groups in one table, full time included", () => {
  const v = view([
    session("a", "waiting", 3),
    session("b", "busy", 5), session("c", "busy", 4),
    session("d1", "idle", 5), session("d2", "idle", 6),
  ]);
  v.sel = "c";
  press(v, "right");
  assert.equal(v.sel, "d1", "past the last possession row comes full time, not the first row");
  press(v, "right");
  assert.equal(v.sel, "d2");
  press(v, "right");
  assert.equal(v.sel, "a", "the last row wraps to the first");
  press(v, "left", true);
  assert.equal(v.sel, "a");
  press(v, "right", true);
  assert.equal(v.sel, "d2");
});

test("down opens the phase window and scrolls it; up scrolls back and closes", () => {
  const steps = Array.from({ length: 14 }, (_, i) => ({ state: "left", label: `step ${i}` }));
  const v = view([session("s1", "busy", 5, { deadhd: { counts: { done: 0, now: 0, blocked: 0 }, total: 14, items: steps } })]);
  Object.assign(v, { sel: "s1" });
  assert.equal(press(v, "down").stop, 1);
  assert.equal(v.expanded.has("s1"), true);
  assert.equal(v.stepTop.s1, 0);
  assert.equal(press(v, "down").stop, 1);
  assert.equal(v.stepTop.s1, 1);
  assert.equal(v.visibleSteps(v.selectedItem(v.viewData())).length, 9);
  assert.equal(press(v, "up").stop, 1);
  assert.equal(v.stepTop.s1, 0);
  assert.equal(press(v, "up").stop, 1);
  assert.equal(v.expanded.has("s1"), false);
});

test("down scrolls no further at the end, and up or down on a row without phases is not handled", () => {
  const steps = Array.from({ length: 14 }, (_, i) => ({ state: "left", label: `step ${i}` }));
  const v = view([
    session("plain", "waiting", 3),
    session("s1", "busy", 5, { deadhd: { counts: { done: 0, now: 0, blocked: 0 }, total: 14, items: steps } }),
  ]);
  Object.assign(v, { sel: "s1", expanded: new Set(["s1"]), stepTop: { s1: 5 } });
  assert.equal(press(v, "down").stop, 1);
  assert.equal(v.stepTop.s1, 5);
  v.sel = "plain";
  assert.equal(press(v, "down").stop, 0);
  assert.equal(press(v, "up").stop, 0);
});

test("right on the last row reveals the hidden full-time rows and selects the first of them", () => {
  const v = view([
    session("b", "busy", 5),
    ...Array.from({ length: 6 }, (_, i) => session(`d${i}`, "idle", 10 + i)),
  ]);
  const data = v.viewData();
  assert.equal(data.hiddenDone, 2, `only ${MAX_DONE} full-time rows show`);
  const items = data.groups.flatMap((group) => group.items);
  v.sel = items.at(-1).sessionId;
  const calls = press(v, "right");
  assert.equal(calls.stop, 1);
  assert.equal(v.showAllDone, true);
  assert.equal(v.sel, "d4", "the first row that was hidden");
});

test("the phase window shows nine rows and clamps its count to the end", () => {
  const steps = Array.from({ length: 14 }, (_, i) => ({ state: "left", label: `step ${i}` }));
  const deadhd = { counts: { done: 0, now: 0, blocked: 0 }, total: 14, items: steps };
  const v = view([session("n", "busy", 5, { deadhd })]);
  const item = v.buildModel(NOW).working[0];
  assert.equal(v.stepCounter(item), "1–9 / 14");
  v.stepTop.n = 9;
  assert.equal(v.visibleSteps(item).length, 9);
  assert.equal(v.stepCounter(item), "6–14 / 14");
  const few = Array.from({ length: 8 }, (_, i) => ({ state: "left", label: `step ${i}` }));
  const fit = view([session("f", "busy", 5, { deadhd: { counts: { done: 0, now: 0, blocked: 0 }, total: 8, items: few } })]);
  assert.equal(fit.stepCounter(fit.buildModel(NOW).working[0]), null);
});

test("shift+enter opens a selected row's progress page, a full-time row's first page, or says why not", () => {
  const v = view([
    session("prog", "waiting", 3, {
      deadhd: { counts: { done: 1, now: 1, blocked: 0 }, total: 2, items: [], pagePath: "/tmp/progress.html" },
    }),
    session("finished", "idle", 4, {
      pages: [{ label: "Progress", url: "https://example.test/page", openable: true }],
      deadhd: { counts: { done: 1, now: 0, blocked: 0 }, total: 1, items: [], pagePath: "/tmp/done.html" },
    }),
    session("plain", "waiting", 5),
  ]);
  const opened = [];
  const flashed = [];
  v.openPage = (page) => opened.push(page);
  v.flash = (_cx, message) => flashed.push(message);
  v.sel = "prog";
  press(v, "enter", false, true);
  assert.deepEqual(opened.at(-1), { url: "/tmp/progress.html", openable: true, files: [] });
  v.sel = "finished";
  press(v, "enter", false, true);
  assert.deepEqual(opened.at(-1), { label: "Progress", url: "https://example.test/page", openable: true });
  v.sel = "plain";
  press(v, "enter", false, true);
  assert.equal(flashed.at(-1), "This row has no match report — pick a session that has one");
});

test("a session name someone chose becomes the topic; a generated one does not", () => {
  assert.equal(chosenTitle("카드 UI 재설계"), "카드 UI 재설계");
  assert.equal(chosenTitle("japanesetutor"), "japanesetutor");
  assert.equal(chosenTitle("herdrchiikawacards-1106-01"), null);
  assert.equal(chosenTitle("shop-api-WEB-1435-1106-02"), null);
  assert.equal(chosenTitle("mv-1791252016"), null);
  assert.equal(chosenTitle("plan-2026-11"), "plan-2026-11", "only a real MMdd stamp marks a generated name");
  assert.equal(chosenTitle(null), null);
  const v = view([
    session("r", "busy", 3, { customTitle: "카드 UI 재설계", deadhd: null, identity: { firstPrompt: "/relay 스킬 때문에 앞 문장이 항상 경로인데" } }),
    session("g", "busy", 3, { customTitle: "herdrchiikawacards-1106-01", identity: { firstPrompt: "레일 고쳐 줘" } }),
  ]);
  const m = v.buildModel(NOW);
  const topic = (id) => [...m.attention, ...m.working, ...m.done].find((i) => i.sessionId === id).topic;
  assert.equal(topic("r"), "카드 UI 재설계", "/rename beats every other source");
  assert.equal(topic("g"), "레일 고쳐 줘");
});

test("the table reads the way Space and Shift+Space move", () => {
  const v = view([
    session("stall", "busy", 30, { lastMeaningfulAt: NOW - 25 * MIN }),
    session("wait-new", "waiting", 3),
    session("wait-old", "waiting", 9),
    session("done-new", "idle", 2),
    session("done-old", "idle", 40),
  ]);
  const model = v.buildModel(NOW);
  assert.deepEqual(model.attention.map((item) => item.sessionId), ["wait-old", "wait-new", "stall"],
    "replies first, oldest first, then the stall Space skips, even though it is older");
  assert.deepEqual(model.done.map((item) => item.sessionId), ["done-new", "done-old"], "the oldest full-time row is last");
});

test("a row's title is the session name, and the last prompt only fills in when there is none", () => {
  const v = view([
    session("p", "idle", 5, { name: null, lastPrompt: "fix the login bug", lastAnswer: "Done. The bug is fixed." }),
    session("web1408ai-1105-04", "busy", 4, { lastPrompt: "/Users/me/orca/workspaces/shop/a.md 를 먼저 읽어" }),
  ]);
  const model = v.buildModel(NOW);
  const item = (sessionId) => [...model.attention, ...model.working, ...model.done].find((i) => i.sessionId === sessionId);
  assert.equal(item("p").title, "fix the login bug");
  assert.equal(item("p").replyTail, "Done. The bug is fixed.");
  assert.equal(item("web1408ai-1105-04").title, "web1408ai-1105-04");
});

test("a click on an unknown row key leaves the selection alone and calls nothing", () => {
  const v = view([session("a", "waiting", 3)]);
  v.sel = "a";
  let moved = 0;
  let notified = 0;
  v.goTo = () => { moved += 1; };
  v.clickRow("row-nope", { notify() { notified += 1; } });
  assert.equal(v.sel, "a");
  assert.equal(moved, 0);
  assert.equal(notified, 0);
});

test("the place puts the ticket key first and drops the repo prefix, rd stamp and hash", () => {
  const p = (cwd) => { const { key, rest, repo, label } = placeOf(cwd); return { key, rest, repo, label }; };
  assert.deepEqual(p("/Users/me/git-repo/shop-api-WEB-1435"), { key: "WEB-1435", rest: "api", repo: "shop", label: "api · shop" });
  assert.deepEqual(p("/Users/me/orca/workspaces/shop/web-1408-ai"), { key: "WEB-1408", rest: "ai", repo: "shop", label: "ai · shop" });
  assert.deepEqual(p("/Users/me/orca/workspaces/shop/WEB-1402"), { key: "WEB-1402", rest: null, repo: "shop", label: "shop" });
  assert.deepEqual(p("/Users/me/git-repo/shop-api-rd-20261103-173837-web-1435-c1acff-story-S1b"),
    { key: "WEB-1435", rest: "api-story-S1b", repo: "shop", label: "api-story-S1b · shop" });
  assert.deepEqual(p("/Users/me/git-repo/herdr-chiikawa-cards"), { key: null, rest: null, repo: null, label: "herdr-chiikawa-cards" });
  assert.equal(placeOf("/x/sessions/C0EXAMPLE01-1793691052_993259", { channel: "C0EXAMPLE01" }).slack, true);
});

test("the ground is the repo plus its folder, Slack for a Maveyyo thread, the leaf otherwise", () => {
  const item = (cwd, extra = {}) => ({ raw: { cwd }, spot: placeOf(cwd), place: null, ...extra });
  assert.equal(groundOf(item("/Users/me/git-repo/shop-api-WEB-1435")), "shop-api");
  assert.equal(groundOf(item("/Users/me/git-repo/acme-deploy")), "acme-deploy");
  assert.equal(groundOf(item("/Users/me/git-repo/herdr-chiikawa-cards")), "herdr-chiikawa-cards");
  const slack = placeOf("/x/C0EXAMPLE01-1793691052_993259", { channel: "C0EXAMPLE01" });
  assert.equal(groundOf({ raw: { cwd: "/x/C0EXAMPLE01-1793691052_993259" }, spot: slack }), "ma’veyyo");
});

test("the topic comes from the handoff, the Slack thread, a pasted brief or the first prompt, cleaned", () => {
  assert.equal(topicOf({ handoff: "WEB-1408 주문 내역 정리 — rolling-delivery 본 핸드오프" }, "WEB-1408"), "주문 내역 정리");
  assert.equal(topicOf({ handoff: "WEB-1435 알림 끄기 이유 묻기 (rolling-delivery)" }, "WEB-1435"), "알림 끄기 이유 묻기");
  assert.equal(topicOf({ maveyyo: { topic: "새 기능 오픈 알림. OCR job c4f5e194, 실패 93건." } }),
    "새 기능 오픈 알림.");
  assert.equal(topicOf({ paste: "일본어 회화 튜터", firstPrompt: "<pasted_content> # 일본어 회화 튜터" }), "일본어 회화 튜터");
  assert.equal(topicOf({ firstPrompt: "[Image #1] 이거 `/relay` 스킬 때문에 앞 문장이 항상 경로야. 고쳐 줘" }), "/relay 스킬 때문에 앞 문장이 항상 경로야.");
  assert.equal(topicOf(null), null);
});

test("a reply loses links, markdown and a bold heading before a list, but keeps a bold sentence", () => {
  assert.equal(cleanMessage("**앞으로 할 것** - **12-14 3차 점검:** `greeting` 표본이 10건을 넘으면 확인해."),
    "12-14 3차 점검: greeting 표본이 10건을 넘으면 확인해.");
  assert.equal(cleanMessage("**자동 실행은 하지 않았어.** HAR을 저장해 줘. http://127.0.0.1:47615/relay/282?h=t18k"),
    "자동 실행은 하지 않았어. HAR을 저장해 줘.");
  assert.equal(cleanMessage("http://127.0.0.1:47615/relay/178"), null);
});

test("the Dossier lists the ticket, pull requests, Slack thread and reports in order", () => {
  const v = view([
    session("j", "busy", 3, { cwd: "/Users/me/git-repo/shop-api-WEB-1435", pr: { number: 9330, url: "https://github.com/acme/web/pull/9330" } }),
    session("m", "idle", 3, { cwd: "/x/maveyyo-bot/sessions/C0EXAMPLE01-1793691052_993259",
      identity: { maveyyo: { channel: "C0EXAMPLE01", lane: "prod", topic: "새 기능 오픈 알림." } } }),
    session("h", "busy", 3, { cwd: "/Users/me/git-repo/herdr-chiikawa-cards" }),
  ]);
  const item = (id) => { const m = v.buildModel(NOW); return [...m.attention, ...m.working, ...m.done].find((i) => i.sessionId === id); };
  assert.deepEqual(linksOf(item("j")).map((l) => [l.kind, l.meta, l.url, l.hot]), [
    ["jira", "WEB-1435", "https://acme.atlassian.net/browse/WEB-1435", "j"],
    ["pr", "web#9330", "https://github.com/acme/web/pull/9330", "p"],
  ]);
  assert.deepEqual(slackThreadOf("/x/C0EXAMPLE01-1793691052_993259"), { channel: "C0EXAMPLE01", ts: "1793691052.993259" });
  assert.equal(slackThreadOf("/Users/me/git-repo/shop"), null);
  assert.deepEqual(linksOf(item("m")).map((l) => [l.kind, l.meta, l.url]),
    [["slack", "prod lane", "https://acme.slack.com/archives/C0EXAMPLE01/p1793691052993259"]]);
  assert.deepEqual(linksOf(item("h")), []);
  assert.deepEqual(linksOf({ jiraKey: null, prLinks: [{ url: "https://g/1", tag: "#1" }, { url: "https://g/2", tag: "#2" }],
    pages: [{ label: "Progress", url: "http://127.0.0.1:1/p", openable: true }] }).map((l) => [l.kind, l.label, l.hot]),
  [["pr", "Pull request", "p"], ["pr", "Pull request", null], ["page", "Report", "g"]]);
});

test("with no config the Dossier has no Jira or Slack row and no repo prefix is known", () => {
  setConfig(DEFAULT_CONFIG);
  const links = linksOf({ jiraKey: "WEB-7", slack: { channel: "C0EXAMPLE01", ts: "1793691052.993259" },
    prLinks: [{ url: "https://g/1", tag: "#1" }], pages: [] });
  assert.deepEqual(links.map((link) => [link.kind, link.hot]), [["pr", "p"]], "j and s have no row to run");
  assert.deepEqual(placeOf("/Users/me/git-repo/shop-api-WEB-1435"),
    { key: "WEB-1435", rest: "shop-api", repo: null, label: "shop-api", slack: false });
  assert.equal(linksOf({ jiraKey: "WEB-7", slack: { channel: "C0EXAMPLE01", ts: "1.2" }, prLinks: [], pages: [] }).length, 0);
});

test("the fm27.json file read at init sets the Dossier bases and the repo prefixes", async () => {
  globalThis.herdrState = {};
  globalThis.herdrFiles = { "/tmp/fm27.json": JSON.stringify(CONFIG) };
  globalThis.localStorage.setItem(SCAN_KEY, "null");
  try {
    const v = new FmSquad();
    v.poll = () => {};
    const tasks = [];
    const cx = { focus_handle: () => ({ focus() {}, is_focused: () => false }), spawn(fn) { tasks.push(fn(cx)); }, notify() {}, timer: { every() {} } };
    v.init({}, cx);
    await tasks[0];
    assert.deepEqual(getConfig(), CONFIG);
    assert.deepEqual(linksOf({ jiraKey: "WEB-7" }).map((link) => link.url), ["https://acme.atlassian.net/browse/WEB-7"]);
    assert.deepEqual(linksOf({ slack: { channel: "C0EXAMPLE01", ts: "1793691052.993259" } }).map((link) => link.url),
      ["https://acme.slack.com/archives/C0EXAMPLE01/p1793691052993259"]);
    assert.equal(placeOf("/Users/me/git-repo/shop-api-WEB-1435").repo, "shop");
  } finally {
    globalThis.herdrFiles = undefined;
    globalThis.herdrState = undefined;
  }
});

test("a missing or invalid fm27.json leaves the defaults without a notice", async () => {
  const init = async (files) => {
    globalThis.herdrState = {};
    globalThis.herdrFiles = files;
    globalThis.localStorage.setItem(SCAN_KEY, "null");
    const v = new FmSquad();
    v.poll = () => {};
    const tasks = [];
    const cx = { focus_handle: () => ({ focus() {}, is_focused: () => false }), spawn(fn) { tasks.push(fn(cx)); }, notify() {}, timer: { every() {} } };
    v.init({}, cx);
    await tasks[0];
    return v;
  };
  try {
    await init({});
    assert.deepEqual(getConfig(), DEFAULT_CONFIG, "no file reads as the defaults");
    await init({ "/tmp/fm27.json": "{not json" });
    assert.deepEqual(getConfig(), DEFAULT_CONFIG, "garbage stays silent");
    await init({ "/tmp/fm27.json": JSON.stringify({ jiraBrowse: 7, slackArchives: "not a url", repos: "shop" }) });
    assert.deepEqual(getConfig(), DEFAULT_CONFIG, "wrong shapes fall back, not up");
    assert.equal(linksOf({ jiraKey: "WEB-7" }).length, 0);
  } finally {
    globalThis.herdrFiles = undefined;
    globalThis.herdrState = undefined;
  }
});

test("a right-click opens the row's Dossier with the card's links and the checklist row", () => {
  const state = {
    terminals: [
      { address: "t1b1", state: "live", cwd: "/repo/cards" },
      { address: "t2c2", state: "live", cwd: "/repo/other" },
    ],
  };
  const card = (id, extra = {}) => session(id, "busy", 3, { cwd: "/repo/cards", where: { kind: "herdr-app", terminalId: "t1b1" }, ...extra });
  const v = view([
    card("none"),
    card("has", { deadhd: { counts: { done: 1, now: 0, blocked: 0 }, total: 1 } }),
    card("off", { deadhd: { off: true, counts: { done: 1, now: 0, blocked: 0 }, total: 1 } }),
    session("lost", "busy", 3, { cwd: "/repo/nowhere", where: { kind: "herdr-app", terminalId: "t2c2" } }),
  ], state);
  const open = (key) => {
    globalThis.herdrOverlays = [];
    v.openLinks(key, { notify() {} });
    return globalThis.herdrOverlays[0];
  };
  const spec = open("row-none");
  assert.equal(v.sel, "none", "the right-clicked row is selected");
  assert.deepEqual([spec.mod, spec.kind, spec.width, spec.props.role], ["fm-squad", "popup", LINKS_W, "links"]);
  assert.equal(spec.height, linksMenuHeight(0, true));
  assert.deepEqual([spec.props.showChecklist, spec.props.terminal, spec.props.working], [true, "t1b1", true]);
  assert.equal(open("row-has").props.showChecklist, false, "a row with a game plan has no checklist row");
  assert.equal(open("row-off").props.showChecklist, true, "deadhd.off is no game plan");
  assert.equal(open("row-lost").props.showChecklist, false, "a session without a live terminal has no row");
  globalThis.herdrOverlays = undefined;
});

test("the Dossier popup opens http links through the system, local reports through open, and reads its keys", () => {
  assert.deepEqual(linksOf({ pages: [{ label: "Progress", url: "http://127.0.0.1:1/p", openable: true },
    { label: "Bad", url: "-a Calculator", openable: false }] }).map((l) => l.url), ["http://127.0.0.1:1/p"],
  "a report scan.sh didn't vouch for stays out of the menu and the copied text");

  globalThis.herdrState = { props: { role: "links", overlay: "o9" } };
  globalThis.herdrClosed = [];
  const opened = [];
  const copied = [];
  let stopped = 0;
  const cx = { open_url: (url) => opened.push(url), write_to_clipboard: (text) => copied.push(text), stop_propagation: () => { stopped += 1; }, notify() {} };
  const v = new FmSquad();
  Object.assign(v, { role: "links", active: 0 });
  const links = [
    { kind: "jira", url: "https://acme.atlassian.net/browse/WEB-1", hot: "j" },
    { kind: "pr", url: "https://github.com/a/b/pull/1", hot: "p" },
    { kind: "page", url: "/tmp/page.html", hot: "g" },
  ];
  v.linksKey("p", links, cx);
  assert.deepEqual(opened, ["https://github.com/a/b/pull/1"]);
  assert.deepEqual(globalThis.herdrClosed, ["o9"], "opening a link closes the menu");
  v.linksKey("g", links, cx);
  assert.equal(opened.length, 1, "a local report is not handed to open_url");
  v.linksKey("up", links, cx);
  assert.equal(v.active, 2, "up wraps to the last row");
  v.linksKey("down", links, cx);
  assert.equal(v.active, 0);
  v.linksKey("enter", links, cx);
  assert.equal(opened.at(-1), "https://acme.atlassian.net/browse/WEB-1");
  const before = stopped;
  v.linksKey("x", links, cx);
  assert.equal(stopped, before, "an unknown key is left alone");
  v.copyLinks(links, cx);
  assert.deepEqual(copied, [links.map((l) => l.url).join("\n")]);
  globalThis.herdrClosed = undefined;
  globalThis.herdrState = {};
});

test("the Dossier popup renders without touching focus, which Herdr refuses during render", () => {
  globalThis.herdrState = { props: { role: "links", head: "WEB-1435", topic: "팀이 알림을 끌 때",
    links: [{ kind: "jira", label: "Jira ticket", meta: "WEB-1435", url: "https://acme.atlassian.net/browse/WEB-1435", hot: "j" }] } };
  const v = new FmSquad();
  Object.assign(v, { role: "links", active: 0, handle: { focus() { throw new Error("focus changed during render"); } } });
  assert.doesNotThrow(() => v.render());
  globalThis.herdrState = { props: { role: "links", head: "x", topic: null, links: [] } };
  assert.doesNotThrow(() => v.render(), "a row with no links renders too");
});

test("a bg session no pane shows is marked Background and its Dossier leads with a stop row", () => {
  const bg = (id, extra = {}) => session(id, "idle", 3, {
    kind: "bg", jobId: id.slice(0, 8), where: { kind: "claude-bg", paneId: null, terminalId: null, attachId: id.slice(0, 8) }, ...extra,
  });
  const v = view([
    bg("d40d716e-left"),
    bg("a1b2c3d4-back", { where: { kind: "claude-bg", paneId: "p1", terminalId: null, attachId: "a1b2c3d4" } }),
    session("plain-idle", "idle", 3),
  ], { panes: [{ pane: "p1", terminal: "t1" }] });
  const done = v.buildModel(NOW).done;
  const card = (id) => done.find((item) => item.sessionId === id);
  assert.equal(card("d40d716e-left").backgrounded, true);
  assert.equal(card("a1b2c3d4-back").backgrounded, false, "an attached pane brings it back to a terminal");
  assert.equal(card("plain-idle").backgrounded, false);
  const open = (key) => {
    globalThis.herdrOverlays = [];
    v.openLinks(key, { notify() {} });
    return globalThis.herdrOverlays[0];
  };
  const spec = open("row-d40d716e-left");
  assert.equal(spec.props.stopId, "d40d716e");
  assert.equal(spec.height, linksMenuHeight(0, false, true));
  assert.equal(open("row-a1b2c3d4-back").props.stopId, null);
  assert.equal(open("row-plain-idle").props.stopId, null);
  assert.equal(linksMenuHeight(2, false, true), linksMenuHeight(2) + 34 + 9);
  globalThis.herdrState = { props: { role: "links", head: "x", topic: null, links: [], stopId: "d40d716e" } };
  const popup = new FmSquad();
  Object.assign(popup, { role: "links", active: 0, handle: { focus() {} } });
  assert.doesNotThrow(() => popup.render(), "the stop row renders");
  globalThis.herdrOverlays = undefined;
  globalThis.herdrState = {};
});

test("the stop row runs claude stop with the job id as a positional arg and closes only when it worked", async () => {
  const stop = async (result) => {
    globalThis.herdrState = { props: { role: "links", overlay: "o9", stopId: "d40d716e" } };
    globalThis.herdrExec = [];
    globalThis.herdrClosed = [];
    globalThis.herdrExecResult = result;
    const v = new FmSquad();
    Object.assign(v, { role: "links", active: 0, stopError: null });
    let task;
    const cx = { notify() {}, spawn(fn) { task = fn(cx); } };
    v.stopSession(cx);
    await task;
    return { exec: globalThis.herdrExec, closed: globalThis.herdrClosed, view: v };
  };
  const ok = await stop(undefined);
  assert.deepEqual(ok.exec, [["sh", ["-lc", 'claude stop "$1"', "x", "d40d716e"]]]);
  assert.deepEqual(ok.closed, ["o9"]);
  const failed = await stop({ code: 1, stdout: "", stderr: "No background session d40d716e." });
  assert.deepEqual(failed.closed, [], "a failed stop keeps the Dossier open");
  assert.equal(failed.view.stopError, "No background session d40d716e");
  globalThis.herdrExec = undefined;
  globalThis.herdrClosed = undefined;
  globalThis.herdrExecResult = undefined;
  globalThis.herdrState = {};
});

test("X and enter on the first row stop the session before any link", () => {
  globalThis.herdrState = { props: { role: "links", overlay: "o9", stopId: "d40d716e" } };
  const v = new FmSquad();
  Object.assign(v, { role: "links", active: 0, stopSession() { this.stopped = (this.stopped ?? 0) + 1; } });
  const rows = [{ stop: true }, { kind: "jira", url: "https://acme.atlassian.net/browse/WEB-1", hot: "j" }];
  const opened = [];
  v.openLink = (link) => { opened.push(link.url); };
  const cx = { stop_propagation() {}, notify() {}, open_url() {} };
  v.linksKey("x", rows, cx);
  v.linksKey("enter", rows, cx);
  assert.equal(v.stopped, 2);
  v.linksKey("j", rows, cx);
  assert.deepEqual(opened, ["https://acme.atlassian.net/browse/WEB-1"]);
  globalThis.herdrState = {};
});

test("the checklist row adds 34 px, plus a 9 px separator when links follow it", () => {
  assert.equal(linksMenuHeight(0, true), linksMenuHeight(0) + 34, "the row appears even with no links");
  assert.equal(linksMenuHeight(2, true), linksMenuHeight(2, false) + 34 + 9);
});

test("the checklist send runs hc with the terminal and the queued prompt as positional args", async () => {
  const send = async (working) => {
    globalThis.herdrState = { props: { role: "links", overlay: "o9", showChecklist: true, terminal: "t1b1", working } };
    globalThis.herdrExec = [];
    globalThis.herdrClosed = [];
    const v = new FmSquad();
    Object.assign(v, { role: "links", active: 0, error: null });
    let task;
    const cx = { notify() {}, spawn(fn) { task = fn(cx); } };
    v.enableChecklist(cx);
    await task;
    return { exec: globalThis.herdrExec, closed: globalThis.herdrClosed, view: v };
  };
  const busy = await send(true);
  assert.deepEqual(busy.exec, [["sh", ["-lc", 'hc send "$1" "$2"', "x", "t1b1", CHECKLIST_QUEUED_PROMPT]]],
    "the prompt and the terminal are single positional arguments");
  assert.deepEqual(busy.closed, ["o9"], "a sent request closes the menu");
  const idle = await send(false);
  assert.deepEqual(idle.exec[0][1].at(-1), CHECKLIST_PROMPT, "an idle session gets the plain prompt");
  assert.equal(idle.view.error, null);
  globalThis.herdrExec = undefined;
  globalThis.herdrClosed = undefined;
  globalThis.herdrState = {};
});

test("C and enter run the highlighted checklist row before any link", () => {
  globalThis.herdrState = { props: { role: "links", overlay: "o9", terminal: "t1b1" } };
  const v = new FmSquad();
  Object.assign(v, { role: "links", active: 0, enableChecklist() { this.enabled = (this.enabled ?? 0) + 1; } });
  const links = [{ kind: "jira", url: "https://acme.atlassian.net/browse/WEB-1", hot: "j" }];
  const rows = [{ checklist: true }, ...links];
  const opened = [];
  v.openLink = (link) => { opened.push(link.url); };
  const cx = { stop_propagation() {}, notify() {}, open_url() {} };
  v.linksKey("c", rows, cx);
  v.linksKey("enter", rows, cx);
  assert.equal(v.enabled, 2, "C and enter on the highlighted row ask for the game plan");
  v.active = 1;
  v.linksKey("enter", rows, cx);
  assert.deepEqual(opened, ["https://acme.atlassian.net/browse/WEB-1"], "row 1 is still the first link");
  v.linksKey("down", rows, cx);
  assert.equal(v.active, 0, "up/down move through the checklist row too");
  globalThis.herdrState = {};
});

test("with nothing to say the commentary shows the last prompt, unless it only points at a handoff", () => {
  const v = view([
    session("q", "idle", 3, { lastPrompt: "이어서 해줘 실수로 다른 거 입력했어." }),
    session("r", "idle", 3, { lastPrompt: "/Users/me/git-repo/shop/.claude/handoff/WEB-1421-S14.md 를 먼저 읽고" }),
  ]);
  const item = (id) => { const m = v.buildModel(NOW); return [...m.attention, ...m.working, ...m.done].find((i) => i.sessionId === id); };
  assert.deepEqual(v.messageOf(item("q")), { text: "↳ 이어서 해줘 실수로 다른 거 입력했어.", quiet: true, spinner: false });
  assert.equal(v.messageOf(item("r")), null);
});

test("the lead line is the now line, the answer or the last reply", () => {
  const v = view([
    session("w", "busy", 4, { currentAction: "running the tests" }),
    session("q", "waiting", 3, { lastAnswer: "Merge it now?" }),
    session("d", "idle", 2, { lastAnswer: "Merged and deployed." }),
    session("e", "idle", 1),
  ]);
  const model = v.buildModel(NOW);
  const item = (sessionId) => [...model.attention, ...model.working, ...model.done].find((entry) => entry.sessionId === sessionId);
  assert.deepEqual(v.leadOf(item("w")), { text: "running the tests", waiting: false, spinner: true });
  assert.equal(v.leadOf(item("q")).text, "Merge it now?");
  assert.equal(v.leadOf(item("d")).text, "Merged and deployed.");
  assert.equal(v.leadOf(item("e")), null);
  const shell = view([session("sh", "shell", 4)]).buildModel(NOW).working[0];
  assert.deepEqual(v.leadOf(shell), { text: "Waiting on background tasks", waiting: true, spinner: false });
  const stepping = view([session("st", "shell", 4, {
    deadhd: { counts: { done: 1, now: 1, blocked: 0 }, total: 3, items: [], nowLabel: "Run the tests" },
  })]).buildModel(NOW).working[0];
  assert.deepEqual(v.leadOf(stepping), { text: "▶ Run the tests", waiting: false, spinner: false });
});

test("ctrl-alt-p on the table hands the keyboard back to the pane below", () => {
  const v = view([session("a", "waiting", 3)]);
  globalThis.herdrRuns = [];
  const calls = press(v, "p", true, false, true);
  assert.deepEqual(globalThis.herdrRuns, [["pane.go", { direction: "down" }]]);
  assert.equal(calls.stop, 1);
  assert.equal(v.query, "");
  delete globalThis.herdrRuns;
});

test("a conversation sent to the background is one row, with the old record's terminal and checklist", () => {
  const cwd = "/repo/cards";
  const deadhd = { counts: { done: 7, now: 0, blocked: 0 }, total: 7, items: [] };
  const old = session("old", "busy", 30, { name: "cards-06", cwd, kind: "interactive", parkedJobId: "94b4d6cf",
    where: { kind: "herdr-app", terminalId: "t17h" }, deadhd });
  const bg = session("bg", "busy", 1, { name: "cards-06", cwd, kind: "bg", jobId: "94b4d6cf", startedAt: NOW,
    where: { kind: "herdr-app", terminalId: "t16r" } });
  const other = session("other", "busy", 2, { name: "cards-07", cwd, startedAt: NOW - 20 * MIN, updatedAt: NOW });
  const folded = foldHandoffs([old, bg, other]);
  assert.deepEqual(folded.map((raw) => raw.sessionId), ["bg", "other"]);
  assert.equal(folded[0].where.terminalId, "t17h");
  assert.equal(folded[0].deadhd, deadhd);
  assert.deepEqual(view([old, bg, other]).buildModel(NOW).working.map((item) => item.sessionId).sort(), ["bg", "other"]);

  const state = {
    terminals: [{ address: "t16r", state: "live", cwd: "/repo/chatwoot" }, { address: "t17h", state: "live", cwd }],
    panes: [{ pane: "p16r", terminal: "t16r" }, { pane: "p17h", terminal: "t17h" }],
  };
  const clicked = view([old, bg], state);
  const row = clicked.buildModel(NOW).working[0];
  globalThis.herdrRuns = [];
  clicked.goTo(row, {});
  assert.deepEqual(globalThis.herdrRuns, [["pane.focus", { pane: "p17h" }]]);
  globalThis.herdrRuns = [];
  const alone = view([bg], state);
  alone.goTo(alone.buildModel(NOW).working[0], { notify() {}, timer: { after() {} } });
  assert.deepEqual(globalThis.herdrRuns, []);
  assert.equal(alone.notice, "Not in Herdr, tmux or Orca — open the session's terminal first");
  globalThis.herdrRuns = undefined;
  const otherJob = { ...bg, jobId: "11111111" };
  assert.equal(foldHandoffs([old, otherJob]).length, 2);
  assert.equal(foldHandoffs([{ ...old, parkedJobId: null }, bg]).length, 2);
});

test("a claude-bg row focuses its attached pane or splits one running claude attach", () => {
  const bg = session("bg-1", "busy", 1, { kind: "bg", where: { kind: "claude-bg", paneId: "p1", attachId: "e7b86417" } });
  const attached = view([bg], { panes: [{ pane: "p1", terminal: "t1" }] });
  globalThis.herdrRuns = [];
  attached.goTo(attached.buildModel(NOW).working[0], {});
  assert.deepEqual(globalThis.herdrRuns, [["pane.focus", { pane: "p1" }]]);
  assert.deepEqual(attached.focusOf(attached.buildModel(NOW).working[0]), { pane: "p1" });

  const detached = view([bg], { panes: [] });
  globalThis.herdrRuns = [];
  detached.goTo(detached.buildModel(NOW).working[0], {});
  assert.deepEqual(globalThis.herdrRuns, [["pane.split", { direction: "right", argv: ["claude", "attach", "e7b86417"] }]]);
  assert.equal(detached.focusOf(detached.buildModel(NOW).working[0]), null);
  globalThis.herdrRuns = [];
  detached.goTo(detached.buildModel(NOW).working[0], {});
  assert.deepEqual(globalThis.herdrRuns, [], "a second click before the next scan opens no second pane");
  globalThis.herdrRuns = undefined;
});

test("an inherited terminal id is trusted only while that terminal sits in the session's folder", () => {
  const live = [
    { address: "t16r", cwd: "/repo/chatwoot", foreground: { pid: 7 } },
    { address: "t17h", cwd: "/repo/cards/" },
  ];
  assert.equal(terminalOf({ pid: 7, cwd: "/repo/cards", where: { terminalId: "t17h" } }, live).address, "t16r");
  assert.equal(terminalOf({ pid: 1, cwd: "/repo/cards", where: { terminalId: "t16r" } }, live), null);
  assert.equal(terminalOf({ pid: 1, cwd: "/repo/cards", where: { terminalId: "t17h" } }, live).address, "t17h");
  assert.equal(terminalOf({ pid: 1, cwd: null, where: { terminalId: "t17h" } }, live), null);
});

test("the selection follows the pane that takes focus, but not while the table has the keyboard", () => {
  const terminals = [
    { address: "t1", state: "live", cwd: "/a", foreground: { pid: 101 } },
    { address: "t2", state: "live", cwd: "/b", foreground: { pid: 102 } },
  ];
  const state = { terminals, focused: { terminal: "t2" } };
  const v = view([session("a", "busy", 5, { pid: 101 }), session("b", "busy", 3, { pid: 102 })], state);
  const revealed = [];
  Object.assign(v, { scroll: { scroll_to_item: (index) => revealed.push(index) }, sel: "a" });
  v.followFocus(v.viewData());
  assert.equal(v.sel, "b");
  assert.equal(revealed.length, 1, "the followed row is scrolled into view");

  v.sel = "a";
  v.followFocus(v.viewData());
  assert.equal(v.sel, "a", "the same pane keeps focus, so a choice made on the table stays");

  state.focused = { terminal: null };
  v.followFocus(v.viewData());
  assert.equal(v.sel, "a");

  v.handle = { is_focused: () => true };
  state.focused = { terminal: "t1" };
  v.sel = "b";
  v.followFocus(v.viewData());
  assert.equal(v.sel, "b", "the table owns the keyboard, so focus changes do not move the cursor");
});

test("focusing a full-time pane marks its row viewed, and the row stays after focus moves on", () => {
  const state = {
    terminals: [
      { address: "t1", state: "live", cwd: "/a", foreground: { pid: 101 } },
      { address: "t2", state: "live", cwd: "/b", foreground: { pid: 102 } },
    ],
    focused: { terminal: "t1" },
  };
  const v = view([session("done", "idle", 5, { pid: 101 }), session("work", "busy", 3, { pid: 102 })], state);
  Object.assign(v, { saveViewed() {} });
  v.followFocus(v.viewData());
  assert.equal(v.sel, "done");
  assert.deepEqual(v.viewed, [v.viewData().model.done[0].ackKey]);
  state.focused = { terminal: "t2" };
  v.followFocus(v.viewData());
  assert.equal(v.sel, "work");
  assert.equal(v.viewData().model.done[0].viewed, true);
});

test("opening a full-time row marks it viewed and keeps its normal time", () => {
  const v = view([session("d", "idle", 5)]);
  Object.assign(v, { saveViewed() {}, flash() {} });
  const [item] = v.viewData(NOW).model.done;
  v.goTo(item, { notify() {}, timer: { after() {} } });
  assert.deepEqual(v.viewed, [item.ackKey]);
  const [after] = v.viewData(NOW).model.done;
  assert.equal(after.viewed, true);
  assert.equal(v.minsLabel(after, NOW), "5m");
});

test("shift-space walks every full-time row from the oldest end, viewed or not, and cycles", () => {
  const v = view([session("w", "busy", 3), session("d-new", "idle", 5), session("d-mid", "idle", 7), session("d-old", "idle", 9)]);
  Object.assign(v, { saveSeen() {}, saveViewed() {}, flash() {}, sel: "w" });
  const done = v.viewData().model.done;
  assert.deepEqual(done.map((item) => item.sessionId), ["d-new", "d-mid", "d-old"]);
  v.viewed = [done[2].ackKey];
  press(v, "space", false, true);
  assert.equal(v.sel, "d-old", "a viewed row is still in the cycle");
  assert.equal(v.showAllDone, true);
  assert.deepEqual(v.seen, [], "opening never marks a row seen");
  press(v, "space", false, true);
  assert.equal(v.sel, "d-mid");
  press(v, "space", false, true);
  press(v, "space", false, true);
  assert.equal(v.sel, "d-old", "past the oldest end it starts again");

  v.sessions = v.sessions.filter((s) => s.sessionId !== "d-old");
  press(v, "space", false, true);
  assert.equal(v.sel, "d-mid", "when the last row visited is gone, the walk restarts at the oldest");

  v.sessions = v.sessions.filter((s) => !s.sessionId.startsWith("d-"));
  v.sel = "w";
  const flashed = [];
  v.flash = (_cx, message) => flashed.push(message);
  press(v, "space", false, true);
  assert.equal(flashed.at(-1), "No session at full time — finish a turn first");
  assert.equal(v.sel, "w");
});

test("space jumps to the longest-waiting touchline call and cycles, skipping stalls", () => {
  const v = view([
    session("stall", "busy", 30, { lastMeaningfulAt: NOW - 25 * MIN }),
    session("old", "waiting", 9),
    session("new", "waiting", 3),
  ]);
  Object.assign(v, { sel: "stall" });
  press(v, "space");
  assert.equal(v.sel, "old");
  press(v, "space");
  assert.equal(v.sel, "new");
  press(v, "space");
  assert.equal(v.sel, "old", "the walk cycles over touchline calls only");
  v.sessions = [session("stall", "busy", 30, { lastMeaningfulAt: NOW - 25 * MIN })];
  v.sel = "stall";
  const flashed = [];
  v.flash = (_cx, message) => flashed.push(message);
  press(v, "space");
  assert.equal(flashed.at(-1), "No touchline call — check back later");
});

test("backspace subs off a full-time row with a 'Subbed off' notice", () => {
  const v = view([session("d", "idle", 3, { cwd: "/Users/me/git-repo/shop-api-WEB-1402" })]);
  Object.assign(v, { saveSeen() {}, saveViewed() {}, sel: "d" });
  const [item] = v.viewData().model.done;
  press(v, "backspace");
  assert.deepEqual(v.seen, [item.ackKey]);
  assert.deepEqual(v.viewData().model.done, []);
  assert.equal(v.notice, "Subbed off WEB-1402");
  assert.deepEqual(v.noticeAction?.label, "Undo");
  assert.equal(v.viewed.length, 0, "subbing off is not viewing");
});

test("pruneSeen drops seen and viewed keys of sessions that are gone", () => {
  const v = view([session("live", "idle", 3)]);
  Object.assign(v, { saveSeen() {}, saveViewed() {} });
  const [item] = v.viewData().model.done;
  v.seen = [item.ackKey, "gone+1"];
  v.viewed = [item.ackKey, "gone+2"];
  v.pruneSeen();
  assert.deepEqual(v.seen, [item.ackKey]);
  assert.deepEqual(v.viewed, [item.ackKey]);
});

test("a subbed-off row hands the selection to the row that takes its place", () => {
  const v = view([session("a", "busy", 9), session("d1", "idle", 3), session("d2", "idle", 5), session("d3", "idle", 7)]);
  Object.assign(v, { saveSeen() {}, saveViewed() {}, flash() {}, sel: "d2", selIndex: 2 });
  press(v, "backspace");
  assert.equal(v.selectedItem(v.viewData()).sessionId, "d3");
});

test("a row whose session ended on its own leaves nothing selected", () => {
  const v = view([session("a", "busy", 9), session("d1", "idle", 3), session("d2", "idle", 5), session("d3", "idle", 7)]);
  Object.assign(v, { sel: "d2", selIndex: 2 });
  v.sessions = v.sessions.filter((s) => s.sessionId !== "d2");
  assert.equal(v.selectedItem(v.viewData()), null, "the neighbour must not look like the session being closed");
  v.sel = "d3";
  assert.equal(v.selectedItem(v.viewData()).sessionId, "d3");
  Object.assign(v, { sel: "gone", selIndex: 0, query: "d3" });
  assert.equal(v.selectedItem(v.viewData())?.sessionId, "d3", "while searching, the first match takes the selection");
  Object.assign(v, { sel: null, query: "" });
  assert.equal(v.selectedItem(v.viewData())?.sessionId, "a", "a table where nothing was chosen yet starts at the first row");
});

test("cmd +/- step the terminals' text size in settings.json and cmd-0 resets it with the zoom", () => {
  const person = { zoom: 0.9, sounds: { enabled: true } };
  assert.deepEqual(nextSettings(person, "font_in"), { ...person, font_size: TERM_FONT + 1 });
  assert.deepEqual(nextSettings(person, "font_out", 15), { ...person, font_size: 14 });
  assert.equal(nextSettings({ font_size: 32 }, "font_in").font_size, 32);
  assert.equal(nextSettings({ font_size: 8 }, "font_out").font_size, 8);
  assert.equal(nextSettings(person, "font_in").zoom, 0.9, "the zoom is left alone");
  assert.deepEqual(nextSettings({ ...person, font_size: 18 }, "font_reset"), { zoom: 1, sounds: { enabled: true } });
  assert.equal(nextSettings(person, "toggle"), null);
  assert.deepEqual(person, { zoom: 0.9, sounds: { enabled: true } }, "the input is not changed");
});

test("the cmd +/-/0 commands write settings.json", async () => {
  const v = new FmSquad();
  globalThis.herdrFiles = { "/tmp/settings.json": JSON.stringify({ zoom: 1 }) };
  try {
    await v.changeTermFont("font_in");
    assert.deepEqual(JSON.parse(globalThis.herdrFiles["/tmp/settings.json"]), { zoom: 1, font_size: TERM_FONT + 1 });
  } finally {
    globalThis.herdrFiles = undefined;
  }
});

test("a visit appends the terminal and ignores a null or repeated one", () => {
  const empty = { list: [], at: -1 };
  const once = visitHistory(empty, "t1");
  assert.deepEqual(once, { list: ["t1"], at: 0 });
  assert.deepEqual(empty, { list: [], at: -1 }, "the input is not changed");
  assert.equal(visitHistory(once, null), once);
  assert.equal(visitHistory(once, "t1"), once);
  assert.deepEqual(visitHistory(visitHistory(once, "t2"), "t3"), { list: ["t1", "t2", "t3"], at: 2 });
  const back = { list: ["t1", "t2", "t3"], at: 0 };
  assert.deepEqual(visitHistory(back, "t9"), { list: ["t1", "t9"], at: 1 });
  let history = { list: [], at: -1 };
  for (let i = 0; i < HISTORY_MAX + 5; i++) history = visitHistory(history, `t${i}`);
  assert.equal(history.list.length, HISTORY_MAX);
  assert.equal(history.list[0], "t5");
  assert.equal(history.at, HISTORY_MAX - 1);
});

test("back and forward step one live terminal at a time and skip dead ones", () => {
  const history = { list: ["t1", "t2", "t3"], at: 2 };
  const back = stepHistory(history, -1, new Set(["t1", "t2", "t3"]));
  assert.deepEqual(back, { history: { list: ["t1", "t2", "t3"], at: 1 }, target: "t2" });
  assert.deepEqual(stepHistory(back.history, -1, new Set(["t1", "t2", "t3"])).target, "t1");
  assert.deepEqual(stepHistory(back.history, 1, new Set(["t1", "t2", "t3"])).target, "t3");
  const skip = stepHistory({ list: ["t1", "t2", "t3", "t4"], at: 3 }, -1, new Set(["t1", "t4"]));
  assert.deepEqual(skip, { history: { list: ["t1", "t2", "t3", "t4"], at: 0 }, target: "t1" });
  const atStart = { list: ["t1", "t2"], at: 0 };
  assert.equal(stepHistory(atStart, -1, new Set(["t1", "t2"])).history, atStart);
});

test("navigate focuses the previous live terminal and leaves the rest to trackVisit", () => {
  const v = new FmSquad();
  Object.assign(v, { history: { list: ["t0", "t1", "t2"], at: 2 }, navTarget: null });
  globalThis.herdrState = { terminals: [{ address: "t0", state: "exited" }, { address: "t1", state: "live" }, { address: "t2", state: "live" }] };
  globalThis.herdrRuns = [];
  try {
    v.navigate(-1);
    assert.deepEqual(globalThis.herdrRuns, [["pane.focus", { terminal: "t1" }]]);
    assert.deepEqual(v.history, { list: ["t0", "t1", "t2"], at: 1 });
    assert.equal(v.navTarget, "t1");
  } finally {
    globalThis.herdrRuns = undefined;
  }
});

test("trackVisit ignores the terminal being left until the back/forward target shows", () => {
  const v = new FmSquad();
  Object.assign(v, { history: { list: ["t1", "t2"], at: 0 }, navTarget: "t1", navUntil: 1000 });
  try {
    globalThis.herdrState = { focused: { terminal: "t2" } };
    v.trackVisit(500);
    assert.deepEqual(v.history, { list: ["t1", "t2"], at: 0 });
    globalThis.herdrState = { focused: { terminal: "t1" } };
    v.trackVisit(600);
    assert.equal(v.navTarget, null);
    Object.assign(v, { navTarget: "t2", navUntil: 1000 });
    globalThis.herdrState = { focused: { terminal: "t3" } };
    v.trackVisit(1500);
    assert.deepEqual(v.history, { list: ["t1", "t3"], at: 1 });
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the squad publishes its notice for the sub bar's pill, and only when it changes", () => {
  const notices = () => globalThis.herdrShared.filter(([name]) => name === NOTICE_KEY).map(([, value]) => value);
  globalThis.herdrShared = [];
  try {
    const v = view([session("w", "busy", 5)]);
    Object.assign(v, { err: null, notice: "Subbed off WEB-1402", noticeAction: { label: "Undo", run() {} } });
    v.publishNotice();
    assert.deepEqual(notices().at(-1), { tone: "note", text: "Subbed off WEB-1402", action: "Undo" });
    const sent = notices().length;
    v.publishNotice();
    assert.equal(notices().length, sent, "an unchanged notice is not republished");
    v.err = "boom";
    v.publishNotice();
    assert.deepEqual(notices().at(-1), { tone: "err", text: "boom", action: "Retry" });
    Object.assign(v, { err: null, notice: null, noticeAction: null });
    v.publishNotice();
    assert.equal(notices().at(-1), null, "clearing both publishes null");
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("the sub bar's pill runs its Retry or Undo through the squad's watch", () => {
  globalThis.herdrShared = [];
  try {
    const v = view([session("w", "busy", 5)]);
    let ran = 0;
    let polls = 0;
    Object.assign(v, {
      notice: "Subbed off WEB-1402", noticeAction: { label: "Undo", run: () => { ran += 1; } }, err: "boom",
      lastNoticeAct: null, lastCmd: null, lastFlash: null, poll: () => { polls += 1; },
    });
    const cx = { notify() {}, timer: { after() {} } };
    setShared(NOTICE_ACT_KEY, { token: "t1", act: "undo" });
    v.watchSquad(cx);
    assert.equal(ran, 1, "the undo action ran");
    assert.equal(v.notice, null);
    v.watchSquad(cx);
    assert.equal(ran, 1, "the same token does not run twice");
    setShared(NOTICE_ACT_KEY, { token: "t2", act: "retry" });
    v.watchSquad(cx);
    assert.equal(v.err, null);
    assert.equal(polls, 1, "Retry polls again");
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("⌘Z undoes the last sub-off while its notice is up, and is left to the host otherwise", () => {
  const v = view([session("w", "busy", 5)]);
  let ran = 0;
  Object.assign(v, { notice: "Subbed off WEB-1402", noticeAction: { label: "Undo", run: () => { ran += 1; } } });
  const calls = pressCmd(v, "z");
  assert.equal(ran, 1);
  assert.equal(v.notice, null);
  assert.equal(calls.stop, 1, "the key is taken");
  pressCmd(v, "z");
  assert.equal(ran, 1, "with no notice there is nothing to undo");
});

test("? toggles the key legend, and types into an open search instead", () => {
  const v = view([session("w", "busy", 5)]);
  Object.assign(v, { showKeys: false, query: "" });
  press(v, "?");
  assert.equal(v.showKeys, true);
  press(v, "/", false, true);
  assert.equal(v.showKeys, false);
  Object.assign(v, { showKeys: false, query: "ami" });
  press(v, "?", false, false, false, "?");
  assert.equal(v.query, "ami?");
  assert.equal(v.showKeys, false, "? is part of the query, not the legend toggle");
});

test("the roster shape counts the touchline, possession and full-time rows", () => {
  const v = view([
    session("a", "waiting", 3),
    session("s", "busy", 20, { lastMeaningfulAt: NOW - 11 * MIN }),
    session("w", "busy", 3),
    session("d", "idle", 4),
  ]);
  const data = v.viewData(NOW);
  assert.equal(data.shape, "2-1-1");
  assert.deepEqual(data.counts, { attention: 2, working: 1, done: 1 });
  assert.deepEqual([stateOf(data.model.attention[0]), stateOf(data.model.attention[1])], ["needs", "stall"]);
  assert.equal(shapeOf({ attention: 3, working: 4, done: 8 }), "3-4-8");
});

test("the published fm.squad shape carries counts, shape, continue, reports and session fields", () => {
  const pages = [
    { pageId: "p1", label: "Progress", url: "https://example.test/1", openable: true, sessionId: "old", createdAt: NOW - 60_000 },
    { pageId: "p2", label: "Regression", url: "https://example.test/2", openable: true, sessionId: "work", createdAt: NOW - 30_000 },
  ];
  const v = view([
    session("old", "waiting", 9, { cwd: "/Users/me/git-repo/shop-api-WEB-100", pages: [pages[0]], identity: { round: 2 } }),
    session("new", "waiting", 3, { cwd: "/Users/me/git-repo/shop-admin-WEB-200" }),
    session("work", "busy", 5, { agent: "codex", cwd: "/Users/me/git-repo/web-WEB-300", pages: [pages[1]],
      deadhd: { title: "Fix routing", counts: { done: 2, now: 1, blocked: 0 }, total: 5,
        items: [{ state: "done", label: "a" }, { state: "done", label: "b" }, { state: "now", label: "c" }, { state: "left", label: "d" }, { state: "left", label: "e" }] },
      pr: { number: 4790, url: "https://github.com/acme/web/pull/4790" } }),
    session("done", "idle", 40),
  ], {}, { meta: { roots: 1, pages, unreadablePages: [] } });
  globalThis.herdrShared = [];
  try {
    v.sel = "work";
    v.publish(v.viewData(NOW), true);
    const value = publishedValue();
    assert.deepEqual(value.counts, { needs: 2, stall: 0, working: 1, done: 1 });
    assert.equal(value.shape, "2-1-1");
    assert.equal(value.total, 4);
    assert.equal(value.grounds, 3);
    assert.equal(value.sel, "work");
    assert.equal(value.continue.key, "old", "the longest-waiting touchline call is the continue target");
    assert.deepEqual(value.continue, { key: "old", ticket: "WEB-100", mins: 9 });
    assert.deepEqual(value.reports.next, { key: "old", ticket: "WEB-100", title: "Progress" });
    assert.equal(value.reports.unread, 2);
    assert.equal(value.reports.unreadable, 0);
    assert.deepEqual(value.history, { canBack: false, canFwd: false });

    const work = value.sessions.find((entry) => entry.key === "work");
    assert.deepEqual(Object.keys(work).sort(), [
      "agent", "ground", "group", "key", "links", "mins", "minsLabel", "msg", "phase", "plan", "pr",
      "reports", "space", "state", "tab", "terminal", "ticket", "title", "viewed",
    ].sort());
    assert.equal(work.agent, "codex");
    assert.equal(work.ground, "web");
    assert.equal(work.state, "working");
    assert.equal(work.group, "working");
    assert.equal(work.pr, "#4790");
    assert.equal(work.links.pr, "https://github.com/acme/web/pull/4790");
    assert.deepEqual(work.reports, [{ id: "p2", title: "Regression", time: work.reports[0].time, unread: true }]);
    assert.deepEqual(work.plan, {
      done: 2, total: 5, cur: 2, top: 0, stale: false,
      steps: [
        { text: "a", state: "ok", note: null },
        { text: "b", state: "ok", note: null },
        { text: "c", state: "cur", note: null },
        { text: "d", state: "left", note: null },
        { text: "e", state: "left", note: null },
      ],
    });
    const old = value.sessions.find((entry) => entry.key === "old");
    assert.equal(old.phase, 2);
    assert.equal(old.minsLabel, "9'");
    assert.equal(old.msg, "Waiting for your reply");
    assert.equal(old.links.jira, "https://acme.atlassian.net/browse/WEB-100");
    assert.equal(value.sessions.find((entry) => entry.key === "done").state, "done");
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("the published state names every space and gives each session its space and tab ids", () => {
  const v = view([session("a", "busy", 3, { cwd: "/x/shop-api-WEB-1", where: { kind: "herdr-app", terminalId: "t1" } })], {
    terminals: [{ address: "t1", state: "live", cwd: "/x/shop-api-WEB-1" }],
    panes: [{ pane: "p1", terminal: "t1", tab: "tb1" }],
    spaces: [{ id: "s1", name: "shop-api", tabs: [{ id: "tb1", name: "1" }] }],
  }, { meta: { roots: 1, pages: [], unreadablePages: ["bad.json", "worse.json"] } });
  globalThis.herdrShared = [];
  try {
    v.publish(v.viewData(NOW), true);
    assert.deepEqual(publishedValue().places, { s1: "shop-api" });
    assert.equal(publishedValue().reports.unreadable, 2);
    const work = publishedValue().sessions.find((entry) => entry.key === "a");
    assert.equal(work.space, "s1", "fm-club counts a crew by its space id");
    assert.equal(work.tab, "tb1");
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("fm-chrome's group filter narrows the table while the published counts stay whole", () => {
  const v = view([session("a", "waiting", 3), session("w", "busy", 5), session("d", "idle", 9)]);
  globalThis.herdrShared = [];
  try {
    v.lastCmd = null;
    const cx = { notify() {}, timer: { after() {} } };
    setShared(CMD_KEY, { token: "f1", name: "filter", args: { group: "working" } });
    v.watchSquad(cx);
    const data = v.viewData(NOW);
    assert.deepEqual(data.groups.map((group) => group.id), ["working"]);
    v.publish(data, false);
    assert.deepEqual(publishedValue().counts, { needs: 1, stall: 0, working: 1, done: 1 });
    setShared(CMD_KEY, { token: "f2", name: "filter", args: { group: null } });
    v.watchSquad(cx);
    assert.deepEqual(v.viewData(NOW).groups.map((group) => group.id), ["attention", "working", "done"]);
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("a read report leaves the unread count and hands Next to the next oldest", () => {
  const pages = [
    { pageId: "p1", label: "Progress", url: "https://x/1", openable: true, sessionId: "a", createdAt: NOW - 60_000 },
    { pageId: "p2", label: "Report", url: "https://x/2", openable: true, sessionId: "b", createdAt: NOW - 30_000 },
  ];
  const v = view([session("a", "waiting", 3), session("b", "waiting", 4)], {}, { meta: { roots: 1, pages, unreadablePages: [] } });
  v.readReports = ["a|p1"];
  globalThis.herdrShared = [];
  try {
    v.publish(v.viewData(NOW), false);
    assert.equal(publishedValue().reports.unread, 1);
    assert.deepEqual(publishedValue().reports.next, { key: "b", ticket: null, title: "Report" });
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("the fm.cmd channel drives select, continue, release, search, report and history", () => {
  globalThis.herdrShared = [];
  try {
    const v = view([
      session("old", "waiting", 9, { pages: [{ pageId: "p1", label: "Progress", url: "https://x/1", openable: true }] }),
      session("new", "waiting", 3),
      session("done", "idle", 4),
    ], {}, { meta: { roots: 1, pages: [{ pageId: "p1", label: "Progress", url: "https://x/1", openable: true, sessionId: "old" }], unreadablePages: [] } });
    const opened = [];
    v.openPage = (page) => opened.push(page);
    v.lastCmd = null;
    const cx = { notify() {}, timer: { after() {} } };
    setShared(CMD_KEY, { token: "c1", name: "select", args: { key: "new" } });
    v.watchSquad(cx);
    assert.equal(v.sel, "new");
    setShared(CMD_KEY, { token: "c2", name: "continue", args: {} });
    v.watchSquad(cx);
    assert.equal(v.sel, "old", "continue lands on the longest-waiting touchline call");
    setShared(CMD_KEY, { token: "c3", name: "next-done", args: {} });
    v.watchSquad(cx);
    assert.equal(v.sel, "done");
    setShared(CMD_KEY, { token: "c4", name: "search", args: { query: "new" } });
    v.watchSquad(cx);
    assert.equal(v.query, "new");
    setShared(CMD_KEY, { token: "c5", name: "release", args: { key: "done" } });
    v.watchSquad(cx);
    assert.deepEqual(v.seen.length, 1, "release subs the row off");
    setShared(CMD_KEY, { token: "c6", name: "report", args: { key: "old", id: "p1" } });
    v.watchSquad(cx);
    assert.equal(opened.at(-1).pageId, "p1");
    setShared(CMD_KEY, { token: "c7", name: "next-report", args: {} });
    v.watchSquad(cx);
    assert.equal(opened.at(-1).pageId, "p1");
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("the overview and inbox write fm.cmd for their actions", () => {
  globalThis.herdrShared = [];
  try {
    const v = new FmSquad();
    v.writeCmd("go", { key: "WEB-1" });
    assert.deepEqual(globalThis.herdrShared.at(-1)[1].name, "go");
    assert.equal(globalThis.herdrShared.at(-1)[1].args.key, "WEB-1");
    v.writeCmd("links", { key: "WEB-1" });
    assert.equal(globalThis.herdrShared.at(-1)[1].name, "links");
    v.writeCmd("continue");
    assert.equal(globalThis.herdrShared.at(-1)[1].name, "continue");
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("the overview reads only fm.squad: empty with no selection, filled from the shared value", () => {
  const v = new FmSquad();
  Object.assign(v, { role: "overview", filter: "all", picked: null });
  globalThis.herdrState = { shared: {} };
  try {
    let heads = 0;
    v.overviewHead = () => { heads += 1; return null; };
    assert.doesNotThrow(() => v.render());
    assert.equal(heads, 0, "nothing selected draws the empty state, not a head");

    globalThis.herdrState.shared[SQUAD_KEY] = {
      sel: "a", counts: { needs: 1, stall: 0, working: 0, done: 0 }, shape: "1-0-0", total: 1, grounds: 1,
      sessions: [{
        key: "a", ticket: "WEB-1", title: "Fix", msg: "now line", state: "working", group: "working", agent: "claude",
        ground: "shop-api", space: null, tab: null, terminal: null, phase: 2, mins: 22, minsLabel: "~6'",
        plan: { done: 3, total: 7, cur: 3, top: 0, stale: false, steps: [{ text: "a", state: "ok", note: null }] },
        reports: [{ id: "p1", title: "Progress", time: "16:02", unread: true }],
        pr: "#4790", links: { jira: null, pr: null, slack: null, page: null }, viewed: false,
      }],
    };
    assert.doesNotThrow(() => v.render());
    assert.equal(heads, 1);
    assert.equal(v.selectedFrom(globalThis.herdrState.shared[SQUAD_KEY]).ticket, "WEB-1");
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the inbox lists touchline calls and unread reports and picks a body", () => {
  globalThis.herdrState = { shared: {} };
  try {
    const v = new FmSquad();
    Object.assign(v, { role: "inbox", filter: "all", picked: null });
    const sessions = [
      { key: "a", ticket: "WEB-1495", title: "DDL", msg: "apply it", state: "needs", group: "attention", agent: "claude",
        ground: "shop-api", phase: 2, mins: 14, minsLabel: "14'", plan: null, reports: [{ id: "p1", title: "Progress", time: "16:02", unread: true }],
        pr: null, links: {}, viewed: false },
      { key: "b", ticket: "WEB-930", title: "regression", msg: "running", state: "working", group: "working", agent: "codex",
        ground: "shop-api", phase: 3, mins: 22, minsLabel: "~6'", plan: null, reports: [],
        pr: "#4790", links: {}, viewed: false },
    ];
    globalThis.herdrState.shared[SQUAD_KEY] = { sel: "b", sessions, reports: { unread: 1, next: null }, counts: {}, shape: "", total: 2, grounds: 1 };
    let bodies = 0;
    v.inboxBody = () => { bodies += 1; return null; };
    assert.doesNotThrow(() => v.render());
    assert.equal(bodies, 1);
    assert.equal(v.inboxChoice(globalThis.herdrState.shared[SQUAD_KEY], sessions, [{ session: sessions[0], report: sessions[0].reports[0] }]).kind, "session");
    assert.equal(v.inboxChoice(globalThis.herdrState.shared[SQUAD_KEY], sessions, []).session.key, "b", "the shared selection wins");
    v.picked = { kind: "report", key: "a", id: "p1" };
    const chosen = v.inboxChoice(globalThis.herdrState.shared[SQUAD_KEY], sessions, [{ session: sessions[0], report: sessions[0].reports[0] }]);
    assert.equal(chosen.kind, "report");
    assert.equal(v.inboxTimeLine(sessions[0], { label: "Touchline" }), "on the touchline for 14 min");
    assert.equal(v.inboxTimeLine(sessions[1], { label: "In possession" }), "in possession for 22 min");
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the table rows are grouped, numbered and hide four full-time rows behind the more row", () => {
  const v = view([
    session("a", "waiting", 3),
    session("w1", "busy", 5), session("w2", "busy", 4),
    ...Array.from({ length: 6 }, (_, i) => session(`d${i}`, "idle", 10 + i)),
  ]);
  const rows = v.tableRows(v.viewData(NOW));
  assert.deepEqual(rows.map((entry) => entry.kind), ["group", "row", "group", "row", "row", "group", "row", "row", "row", "row", "more"]);
  assert.deepEqual(rows.filter((entry) => entry.kind === "row").map((entry) => entry.number), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(rows.filter((entry) => entry.kind === "row").map((entry) => entry.item.sessionId), ["a", "w1", "w2", "d0", "d1", "d2", "d3"]);
  const more = rows.at(-1);
  assert.equal(more.count, 2);
  assert.equal(more.key, "more-done");
});

test("a row with a game plan shows its phase count and progress, and a stale plan dims", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ state: i < 2 ? "done" : i === 2 ? "now" : "left", label: `s${i}` }));
  const v = view([session("w", "busy", 4, { deadhd: { counts: { done: 2, now: 1, blocked: 0 }, total: 5, items, dataAt: NOW - 31 * MIN } })]);
  const plan = v.planOf(v.buildModel(NOW).working[0]);
  assert.deepEqual([plan.done, plan.total, plan.cur, plan.stale], [2, 5, 2, true]);
  assert.deepEqual(planStep({ state: "blocked", label: "x", ask: "why" }), { text: "x", state: "cur", note: "why" });
});

test("the squad render draws the head, columns and rows without a handler inside a row", () => {
  const v = view([session("a", "waiting", 3, { pages: [{ label: "Progress", url: "https://x", openable: true }] }), session("d", "idle", 9)]);
  Object.assign(v, { handle: { focus() {}, is_focused: () => false }, published: null });
  v.sel = "a";
  globalThis.herdrShared = [];
  try {
    assert.doesNotThrow(() => v.render({ notify() {}, timer: { after() {}, every() {} } }));
    assert.ok(publishedValue()?.sessions.length === 2);
    assert.equal(publishedValue().sel, "a");
    const sel = globalThis.herdrShared.filter(([name]) => name === SEL_KEY).at(-1)?.[1];
    assert.deepEqual(sel, { key: "a" });
  } finally {
    globalThis.herdrShared = undefined;
  }
});

test("an empty squad says so in English, and a search says why it is empty", () => {
  assert.equal(NO_PAGE_FLASH, "No page can open yet — try again after the scan");
  const v = view([]);
  assert.doesNotThrow(() => v.table(v.viewData(NOW)));
});

test("one column spec drives the header and every row; narrow panels drop columns in order", () => {
  const ids = COLUMNS.map((col) => col.id);
  assert.deepEqual(ids, ["si", "no", "ticket", "brief", "nat", "ground", "phase", "mins", "plan", "rpt", "pr"]);
  assert.deepEqual(COLUMN_DROP, ["pr", "rpt", "phase", "ground", "plan"]);
  assert.deepEqual(visibleColumns(1600), ids, "a wide panel keeps every column");
  assert.deepEqual(visibleColumns(0), ids, "before layout reports a width, keep every column");
  assert.deepEqual(visibleColumns(774), ["si", "no", "ticket", "brief", "nat", "ground", "mins", "plan"]);
  assert.deepEqual(visibleColumns(690), ["si", "no", "ticket", "brief", "nat", "mins", "plan"]);
  assert.deepEqual(visibleColumns(450), ["si", "no", "ticket", "brief", "nat", "mins"]);
});

test("the header and the data rows shed the same columns at a narrow width", () => {
  const v = view([session("a", "waiting", 3)]);
  Object.assign(v, { width: 450, handle: { focus() {}, is_focused: () => false } });
  assert.doesNotThrow(() => v.columns());
  assert.doesNotThrow(() => v.table(v.viewData(NOW)));
  assert.equal(v.shownColumns().includes("pr"), false);
});

test("every role renders with nothing in Herdr and with fm.squad null", () => {
  const render = (v) => v.render({ notify() {}, timer: { after() {}, every() {} } });
  try {
    for (const state of [{}, { shared: { [SQUAD_KEY]: null } }, { shared: { [SQUAD_KEY]: {} } }]) {
      const squad = view([], state);
      assert.doesNotThrow(() => render(squad), "squad role");
      for (const role of ["overview", "inbox", "links"]) {
        globalThis.herdrState = state;
        const v = new FmSquad();
        Object.assign(v, { role, filter: "all", picked: null, active: 0, error: null,
          handle: { focus() {}, is_focused: () => false } });
        assert.doesNotThrow(() => v.render(), `${role} role`);
      }
    }
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the inbox filter is published, and fm-chrome's inbox-filter command changes it", () => {
  const v = view([]);
  globalThis.herdrShared = [];
  try {
    v.render({ notify() {}, timer: { after() {}, every() {} } });
    assert.equal(publishedValue().inboxFilter, "all", "the published state carries the filter");
    v.runCommand({ name: "inbox-filter", args: { kind: "reports" } }, { notify() {} });
    assert.equal(v.inboxFilter, "reports");
    assert.equal(publishedValue().inboxFilter, "reports", "the change reaches fm.squad without a redraw");
    v.runCommand({ name: "inbox-filter", args: { kind: "nonsense" } }, { notify() {} });
    assert.equal(v.inboxFilter, "all");
    assert.deepEqual(INBOX_KINDS, ["all", "touchline", "reports"]);
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("the inbox role follows the published filter, and keeps its own until one arrives", () => {
  const v = new FmSquad();
  Object.assign(v, { role: "inbox", filter: "all", picked: null });
  globalThis.herdrState = { shared: {} };
  try {
    assert.equal(v.inboxFilterFor({}), "all");
    v.filter = "touchline";
    assert.equal(v.inboxFilterFor({}), "touchline", "no published value yet, so its own choice stays");
    assert.equal(v.inboxFilterFor({ inboxFilter: "reports" }), "reports", "a published change wins");
    assert.equal(v.inboxFilterFor({ inboxFilter: "reports" }), "reports");
    assert.equal(v.inboxFilterFor({ inboxFilter: "junk" }), "reports", "a bad value is ignored");
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the table's agent order is handed to herdr.setAgentOrder by name", () => {
  const v = view([session("a", "waiting", 3, { pid: 42 })], {
    terminals: [{ address: "t1", state: "live", foreground: { pid: 42 } }],
  });
  Object.assign(v, { handle: { focus() {}, is_focused: () => false } });
  globalThis.herdrAgentOrder = undefined;
  try {
    v.render({ notify() {}, timer: { after() {}, every() {} } });
    assert.deepEqual(globalThis.herdrAgentOrder, ["t1"]);
  } finally {
    globalThis.herdrAgentOrder = undefined;
  }
});

test("fm.squad is published without a render, from the poll completion and the focus watch", async () => {
  const v = view([session("a", "waiting", 4), session("w", "busy", 2)]);
  Object.assign(v, { handle: { focus() {}, is_focused: () => false } });
  globalThis.herdrState = { agents: [], terminals: [], panes: [], spaces: [] };
  globalThis.herdrShared = [];
  try {
    const tasks = [];
    v.poll({ spawn: (fn) => tasks.push(fn({ notify() {}, timer: { after() {} } })), notify() {} });
    await Promise.all(tasks);
    assert.ok(publishedValue(), "the poll completion writes the state a hidden table never draws");

    assert.equal(v.watchSquad === undefined, false);
    v.watchSquad({ notify() {}, timer: { after() {} } });
    assert.equal(publishedValue().counts.needs, 1, "the focus watch carries the touchline count");
    assert.equal(publishedValue().counts.working, 1, "and the in-possession count");
    assert.equal(publishedValue().sel, null);
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("a saved scan restores the model the same data built live, before the first poll", () => {
  const meta = { roots: 1, pages: [], unreadablePages: [] };
  const sessions = [
    session("a", "waiting", 3),
    session("w", "busy", 5),
    session("s", "busy", 20, { lastMeaningfulAt: NOW - 11 * MIN }),
    session("d", "idle", 9),
  ];
  const scanned = view(sessions, {}, { meta });
  const expected = scanned.buildModel(NOW);
  scanned.saveScan(NOW - MIN);
  const restored = view([]);
  assert.equal(restored.restoreScan(NOW), true);
  assert.deepEqual(restored.sessions, JSON.parse(JSON.stringify(sessions)));
  assert.deepEqual(restored.buildModel(NOW), expected);
  assert.equal(restored.restoreScan(NOW), true, "a cache inside the window still restores");
});

test("a cache older than 30 minutes, or a corrupt one, is ignored and leaves the squad empty", () => {
  const meta = { roots: 1, pages: [], unreadablePages: [] };
  const sessions = [session("a", "waiting", 3)];
  globalThis.localStorage.setItem(SCAN_KEY, JSON.stringify({ at: NOW - SCAN_TTL_MS - MIN, sessions, meta }));
  const stale = view([]);
  assert.equal(stale.restoreScan(NOW), false);
  assert.deepEqual(stale.sessions, []);
  assert.equal(stale.meta.roots, 1, "the defaults the view was built with are left alone");

  globalThis.localStorage.setItem(SCAN_KEY, "{not json");
  assert.equal(view([]).restoreScan(NOW), false);
  globalThis.localStorage.setItem(SCAN_KEY, JSON.stringify({ at: NOW, sessions: "nope", meta }));
  assert.equal(view([]).restoreScan(NOW), false);
  globalThis.localStorage.setItem(SCAN_KEY, JSON.stringify({ at: "soon", sessions, meta }));
  assert.equal(view([]).restoreScan(NOW), false);
  globalThis.localStorage.setItem(SCAN_KEY, "null");
  assert.equal(view([]).restoreScan(NOW), false);
});

test("the cache is published during init without a render, and a missing one publishes nothing", () => {
  const meta = { roots: 1, pages: [], unreadablePages: [] };
  const make = () => {
    const v = new FmSquad();
    v.poll = () => {};
    let draws = 0;
    v.render = () => { draws += 1; };
    const cx = { focus_handle: () => ({ focus() {}, is_focused: () => false }), spawn() {}, notify() {}, timer: { every() {} } };
    v.init({}, cx);
    return { v, draws: () => draws };
  };
  globalThis.herdrState = {};
  try {
    globalThis.herdrShared = [];
    globalThis.localStorage.setItem(SCAN_KEY, JSON.stringify({ at: Date.now(), sessions: [session("a", "waiting", 3), session("w", "busy", 5)], meta }));
    const restored = make();
    assert.equal(restored.v.sessions.length, 2, "the table starts from the cached scan");
    assert.equal(restored.draws(), 0, "no render ran");
    assert.equal(publishedValue().counts.needs, 1);
    assert.equal(publishedValue().counts.working, 1);

    globalThis.herdrShared = [];
    globalThis.localStorage.setItem(SCAN_KEY, JSON.stringify({ at: Date.now() - SCAN_TTL_MS - MIN, sessions: [], meta }));
    make();
    assert.equal(publishedValue(), null, "a stale cache publishes nothing");
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("the layout keys arrive as fm.cmd: toggle takes or leaves the keyboard, fonts reach settings", async () => {
  globalThis.herdrRuns = [];
  globalThis.herdrShared = [];
  try {
    let focused = false, focusCalls = 0;
    const v = view([]);
    globalThis.herdrState = { layout: { id: "root", children: [{ id: "screens", active: "inbox", children: [] }] } };
    Object.assign(v, { handle: { is_focused: () => focused, focus: () => { focusCalls += 1; focused = true; } } });

    v.runCommand({ name: "toggle", args: {} }, { notify() {} });
    assert.deepEqual(globalThis.herdrRuns[0], ["layout.select", { stack: "screens", child: "squad" }],
      "another screen switches to Squad first");
    assert.equal(globalThis.herdrShared.filter(([name]) => name === "fm.screen").at(-1)?.[1], "squad");
    assert.equal(focusCalls, 1, "then the table takes the keyboard");

    v.runCommand({ name: "toggle", args: {} }, { notify() {} });
    assert.deepEqual(globalThis.herdrRuns.at(-1), ["pane.go", { direction: "down" }],
      "on the table, ctrl-alt-p hands the keyboard back to the terminal");

    const fonts = [];
    v.changeTermFont = async (name) => { fonts.push(name); };
    for (const name of ["font_in", "font_out", "font_reset"]) v.runCommand({ name, args: {} }, { notify() {} });
    await Promise.resolve();
    assert.deepEqual(fonts, ["font_in", "font_out", "font_reset"]);
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrRuns = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("the inbox has a calm empty body and falls back to it when the picked row vanished", () => {
  assert.deepEqual(INBOX_EMPTY, {
    title: "Nothing on the touchline",
    hint: "Sessions that need your instructions and new match reports land here",
  });
  globalThis.herdrState = { shared: {} };
  try {
    const v = new FmSquad();
    Object.assign(v, { role: "inbox", filter: "all", picked: null });
    assert.equal(v.inboxChoice({}, [], []), null, "an empty inbox takes the empty body");
    const rows = [{ key: "a" }, { key: "b" }];
    v.picked = { kind: "session", key: "gone" };
    assert.equal(v.inboxChoice({}, rows, []), null, "a session that vanished leaves the empty body");
    v.picked = { kind: "report", key: "a", id: "p9" };
    assert.equal(v.inboxChoice({}, rows, []), null, "a report row that vanished too");
    v.picked = null;
    assert.equal(v.inboxChoice({ sel: "b" }, rows, []).session.key, "b", "the shared selection still wins");
    assert.doesNotThrow(() => v.inboxEmpty());
  } finally {
    globalThis.herdrState = undefined;
  }
});
