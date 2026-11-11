import test from "node:test";
import assert from "node:assert/strict";
import FmChrome, {
  INBOX_KINDS,
  KEY_COMMANDS,
  KEYS_LEGEND,
  forwardKeyCommand,
  keyCommand,
  TOP_BAR_STEPS,
  clockLabel,
  continueLabel,
  currentScreen,
  dateLabel,
  groundName,
  groundSub,
  menuBadge,
  noticeView,
  subTabs,
  topBarLayout,
  touchlineCount,
} from "../mods/fm-chrome/main.js";

test("dateLabel: weekday, zero-padded day/month, full year", () => {
  assert.equal(dateLabel(new Date(2026, 10, 11)), "WED 11/11/2026");
  assert.equal(dateLabel(new Date(2026, 2, 4)), "WED 04/03/2026");
  assert.equal(dateLabel(new Date(2027, 0, 1)), "FRI 01/01/2027");
});

test("clockLabel: zero-padded 24h HH:MM", () => {
  assert.equal(clockLabel(new Date(2026, 10, 11, 16, 5)), "16:05");
  assert.equal(clockLabel(new Date(2026, 10, 11, 9, 7)), "09:07");
  assert.equal(clockLabel(new Date(2026, 10, 11, 0, 0)), "00:00");
});

test("touchlineCount: needs you plus stoppages", () => {
  assert.equal(touchlineCount({ needs: 2, stall: 1, working: 4, done: 8 }), 3);
  assert.equal(touchlineCount({ needs: 0, stall: 0 }), 0);
  assert.equal(touchlineCount(), 0);
});

test("menuBadge: only Inbox carries the touchline count, and only when it is non-zero", () => {
  assert.equal(menuBadge("inbox", { needs: 2, stall: 1 }), 3);
  assert.equal(menuBadge("inbox", { needs: 0, stall: 0, done: 5 }), null);
  assert.equal(menuBadge("squad", { needs: 2, stall: 1 }), null);
  assert.equal(menuBadge("staff", { needs: 2 }), null);
  assert.equal(menuBadge("club", {}), null);
});

test("continueLabel: the longest touchline call, or nothing", () => {
  assert.deepEqual(continueLabel({ key: "t7", ticket: "WEB-1495", mins: 14 }), {
    text: "Continue",
    sub: "WEB-1495 on the touchline, 14 min",
    enabled: true,
  });
  assert.equal(continueLabel({ key: "t9", ticket: null, mins: 3 }).sub, "t9 on the touchline, 3 min");
  const none = continueLabel(null);
  assert.equal(none.enabled, false);
  assert.equal(none.sub, "Nothing on the touchline");
});

test("subTabs: one set per screen", () => {
  const counts = { needs: 2, stall: 1, working: 4, done: 8 };
  assert.deepEqual(subTabs("squad", counts), [
    { id: "all", label: "Overview" },
    { id: "attention", label: "Touchline", count: 3, tone: "needs" },
    { id: "working", label: "In possession", count: 4, tone: "working" },
    { id: "done", label: "Full time", count: 8, tone: "done" },
  ]);
  assert.deepEqual(subTabs("inbox", counts), [
    { id: "all", label: "All" },
    { id: "touchline", label: "Touchline" },
    { id: "reports", label: "Match reports" },
  ]);
  assert.deepEqual(subTabs("staff", counts), [], "Staff shows only the crumb");
  assert.deepEqual(subTabs("club", counts), [], "Club shows only the crumb");
  assert.deepEqual(subTabs("nowhere", counts), []);
  assert.deepEqual(INBOX_KINDS, ["all", "touchline", "reports"]);
});

test("topBarLayout: scouted down from everything to icon, then the date line, then the club name", () => {
  assert.deepEqual(topBarLayout(1680), { min: 1520, scout: 150, date: "full", club: 200 });
  assert.deepEqual(topBarLayout(1500), { min: 1480, scout: 110, date: "full", club: 200 });
  assert.deepEqual(topBarLayout(1440), { min: 1410, scout: "icon", date: "full", club: 200 });
  assert.deepEqual(topBarLayout(1380), { min: 1380, scout: "icon", date: "compact", club: 170 });
  assert.deepEqual(topBarLayout(1280), { min: 1230, scout: "icon", date: "clock", club: 150 });
  assert.deepEqual(topBarLayout(900), TOP_BAR_STEPS.at(-1));
  assert.deepEqual(topBarLayout(0), TOP_BAR_STEPS[0], "no width yet reads as the widest window");
  assert.deepEqual(topBarLayout(undefined), TOP_BAR_STEPS[0]);
});

const renderChrome = (role, state) => {
  globalThis.herdrState = state;
  const v = new FmChrome();
  Object.assign(v, {
    role, sub: {}, editing: false, query: "", clock: "16:05", width: 0,
    handle: { focus() {}, release() {}, is_focused: () => false },
  });
  return v.render({ notify() {}, timer: { after() {}, every() {} } });
};

test("both bars render with nothing in Herdr and with fm.squad null or empty", () => {
  try {
    for (const state of [{}, { shared: { "fm.squad": null } }, { shared: { "fm.squad": {} } }]) {
      assert.doesNotThrow(() => renderChrome("top", state), "top bar, empty state");
      // No fm.notice in any of these: the sub bar must draw no pill rather than read it as null.
      assert.doesNotThrow(() => renderChrome("sub", state), "sub bar, empty state and no notice");
    }
    assert.doesNotThrow(() => renderChrome("sub", { shared: { "fm.notice": { tone: "note", text: "Sent", action: null } } }));
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("noticeView: tone, result and the action that answers it", () => {
  assert.equal(noticeView(null), null);
  assert.equal(noticeView({ text: "" }), null);
  assert.deepEqual(noticeView({ tone: "err", text: "scan failed", action: "Retry" }), {
    tone: "err",
    text: "scan failed",
    action: "Retry",
    act: "retry",
    label: "Retry",
  });
  assert.deepEqual(noticeView({ tone: "note", text: "Subbed off WEB-1402", action: "Undo" }), {
    tone: "note",
    text: "Subbed off WEB-1402",
    action: "Undo",
    act: "undo",
    label: "Undo ⌘Z",
  });
  assert.deepEqual(noticeView({ text: "Sent", action: null }), {
    tone: "note",
    text: "Sent",
    action: null,
    act: null,
    label: null,
  });
});

test("groundName and groundSub: the switcher's label", () => {
  assert.equal(groundName(null), "Herdr");
  assert.equal(groundName({ id: "s1", name: "shop-api" }), "shop-api");
  assert.equal(groundName({ id: "s1", name: "shop-api" }, { s1: "WEB-930" }), "WEB-930");
  assert.equal(groundSub(3, 9), "Ground 3 of 9");
  assert.equal(groundSub(0, 0), "No ground");
});

test("currentScreen: the screens stack wins, then the stored id, then Squad", () => {
  const tree = { id: "root", children: [{ id: "screens", active: "club", children: [] }] };
  assert.equal(currentScreen(tree, "inbox"), "club");
  assert.equal(currentScreen({ children: [{ id: "screens", active: "missing" }] }, "inbox"), "inbox");
  assert.equal(currentScreen(null, null), "squad");
  assert.equal(currentScreen(null, "nonsense"), "squad");
});

test("KEYS_LEGEND: the twelve keys the sub bar advertises, in order", () => {
  assert.deepEqual(KEYS_LEGEND.map((entry) => entry.label), [
    "Select",
    "Watch live",
    "Phases",
    "Sub off / rest",
    "Undo",
    "Continue",
    "Next full time",
    "Dossier",
    "Next match report",
    "Back",
    "First / last",
    "Match report",
  ]);
  for (const entry of KEYS_LEGEND) assert.ok(entry.keys.length > 0);
});

test("the inbox sub tabs drive the inbox through fm.cmd", () => {
  globalThis.herdrState = {};
  globalThis.herdrShared = [];
  try {
    const v = new FmChrome();
    Object.assign(v, { role: "sub", sub: {} });
    v.pickSub("inbox", "reports", { notify() {} });
    const [name, cmd] = globalThis.herdrShared.at(-1);
    assert.equal(name, "fm.cmd");
    assert.equal(cmd.name, "inbox-filter");
    assert.deepEqual(cmd.args, { kind: "reports" });
    v.pickSub("inbox", "touchline", { notify() {} });
    assert.equal(globalThis.herdrShared.at(-1)[1].args.kind, "touchline");
    v.pickSub("squad", "working", { notify() {} });
    assert.equal(globalThis.herdrShared.at(-1)[1].name, "filter", "the squad tabs keep their own command");
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("the layout keys reach the squad as one fm.cmd each, and nothing else is taken", () => {
  globalThis.herdrState = {};
  globalThis.herdrShared = [];
  try {
    const v = new FmChrome();
    Object.assign(v, { role: "top", sub: {}, editing: false, query: "", width: 0, clock: "16:05" });
    for (const name of KEY_COMMANDS) assert.equal(forwardKeyCommand(v, name), true, name);
    assert.deepEqual(globalThis.herdrShared.map(([key, value]) => [key, value.name, value.args]),
      KEY_COMMANDS.map((name) => ["fm.cmd", name, {}]));
    assert.equal(forwardKeyCommand(v, "focus"), false);
    assert.equal(forwardKeyCommand(v, "save"), false);
    assert.equal(globalThis.herdrShared.length, KEY_COMMANDS.length, "an unknown command writes nothing");
    assert.deepEqual(KEY_COMMANDS, ["toggle", "font_in", "font_out", "font_reset", "back", "forward"]);
    assert.deepEqual(keyCommand("font_out"), { name: "font_out", args: {} });
    assert.equal(keyCommand("focus"), null);
  } finally {
    globalThis.herdrState = undefined;
    globalThis.herdrShared = undefined;
  }
});

test("only the top bar listens for layout keys; the sub bar is shown too and would forward twice", () => {
  const spawns = [];
  const cx = {
    focus_handle: () => ({ focus() {}, is_focused: () => false }),
    spawn: (fn) => spawns.push(fn),
    timer: { every() {} },
  };
  try {
    globalThis.herdrState = { props: { role: "top" } };
    new FmChrome().init({}, cx);
    assert.equal(spawns.length, 1, "the top bar listens");
    globalThis.herdrState = { props: { role: "sub" } };
    new FmChrome().init({}, cx);
    assert.equal(spawns.length, 1, "the sub bar stays out of the key loop");
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the sub bar shows Overview again when the squad publishes a cleared group filter", () => {
  const layout = { id: "root", children: [{ id: "screens", active: "squad", children: [] }] };
  try {
    globalThis.herdrState = { layout, shared: { "fm.squad": { groupFilter: "working" } } };
    const v = new FmChrome();
    Object.assign(v, { role: "sub", sub: {} });
    v.render({ notify() {} });
    assert.equal(v.sub.squad, "working", "the squad's tab choice reaches the chrome");
    v.pickSub("squad", "all", { notify() {} });
    assert.equal(v.sub.squad, "all", "its own click highlights before the poll comes back");
    globalThis.herdrState.shared["fm.squad"] = { groupFilter: "attention" };
    v.render({ notify() {} });
    assert.equal(v.sub.squad, "attention", "another tab click wins again");
    globalThis.herdrState.shared["fm.squad"] = { groupFilter: null };
    v.render({ notify() {} });
    assert.equal(v.sub.squad, "all", "Esc in the squad brings Overview back");
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the sub bar follows the inbox filter the squad publishes, and its own click shows at once", () => {
  const layout = { id: "root", children: [{ id: "screens", active: "inbox", children: [] }] };
  try {
    globalThis.herdrState = { layout, shared: { "fm.squad": { inboxFilter: "touchline" } } };
    const v = new FmChrome();
    Object.assign(v, { role: "sub", sub: {} });
    assert.doesNotThrow(() => v.render({ notify() {} }));
    assert.equal(v.sub.inbox, "touchline", "a choice made in the inbox reaches the chrome tabs");
    v.pickSub("inbox", "reports", { notify() {} });
    assert.equal(v.sub.inbox, "reports", "its own click highlights before the poll comes back");
    globalThis.herdrState.shared["fm.squad"] = { inboxFilter: "all" };
    v.render({ notify() {} });
    assert.equal(v.sub.inbox, "all", "a later inbox change wins again");
  } finally {
    globalThis.herdrState = undefined;
  }
});
