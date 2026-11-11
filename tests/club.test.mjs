// Model tests for the fm-club mod: space grouping into grounds, crew counts, the switcher's
// status icon and the space.move reorder. Run:
// node --import ./tests/stubs/register.mjs --test tests/club.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import FMClub, {
  railKey, cwdOf, spaceName, setRepoPrefixes, rowName, crewOf, crewPills, statusOf, idleText, shellsIn, clubTree, groupOrder, folderLabel,
} from "../mods/fm-club/main.js";

const MIN = 60_000;
const IDLE = 10 * MIN;

const session = (space, tab, state, key, title) => ({ space, tab, state, key, ticket: key, title });

test("the switcher's ↑↓ move the row highlight and wrap, and ↩ or Space pick it", () => {
  assert.deepEqual(railKey("down", 1, 3), { at: 2, select: false });
  assert.deepEqual(railKey("down", 2, 3), { at: 0, select: false }, "↓ wraps to the first row");
  assert.deepEqual(railKey("up", 0, 3), { at: 2, select: false }, "↑ wraps to the last row");
  assert.deepEqual(railKey("enter", 1, 3), { at: 1, select: true });
  assert.deepEqual(railKey("space", 1, 3), { at: 1, select: true });
  assert.equal(railKey("down", 0, 0), null, "an empty list takes no key");
  assert.equal(railKey("left", 0, 3), null, "a key the club does not use is left to the host");
});

test("a ground's repository comes from where a terminal's program runs now, not where it opened", () => {
  assert.equal(cwdOf({ cwd: "/Users/me/orca/workspaces/shop/web-1408-ai", foreground: { cwd: "/Users/me/git-repo/herdr-fm27" } }),
    "/Users/me/git-repo/herdr-fm27");
  assert.equal(cwdOf({ cwd: "/a", foreground: { pid: 1 } }), "/a");
  assert.equal(cwdOf(null), null);
});

test("a space with no session label is named from its own space name", () => {
  assert.deepEqual(spaceName("shop-api-WEB-1435", ["shop"]), { key: "WEB-1435", rest: "api" });
  assert.deepEqual(spaceName("shop-api-WEB-1435"), { key: "WEB-1435", rest: "shop-api" }, "no configured repos keeps every word");
  assert.deepEqual(spaceName("api-gateway-WEB-1", ["shop"]), { key: "WEB-1", rest: "api-gateway" }, "only a configured repo prefix is dropped");
  assert.deepEqual(spaceName("web-1312-mvp-ai-chatbot"), { key: "WEB-1312", rest: "mvp-ai-chatbot" });
  assert.deepEqual(spaceName("shop-WEB-1402-rd-20261105-101500-a1b2c3", ["shop"]), { key: "WEB-1402", rest: null });
  assert.deepEqual(spaceName("herdr-fm27"), { key: null, rest: "herdr-fm27" });
});

test("a ground's home checkout reads base over its space name", () => {
  assert.deepEqual(rowName("shop-api", true), { key: "base", rest: "shop-api" });
  assert.deepEqual(rowName("shop-api", false), { key: null, rest: "shop-api" });
  assert.deepEqual(rowName("web-1408-ai", true), { key: "WEB-1408", rest: "ai" }, "a keyed space keeps its key");
  assert.deepEqual(rowName("base", true), { key: null, rest: "base" }, "a space already called base is not doubled");
  assert.deepEqual(rowName({ key: "WEB-1435", rest: "api" }, false), { key: "WEB-1435", rest: "api" },
    "the cards' place shape is taken as it is");
  assert.deepEqual(rowName({ key: null, rest: "shared-cards" }, true), { key: "base", rest: "shared-cards" });
});

test("a space's crew counts its sessions by state, optionally one tab only", () => {
  const sessions = [
    session("s1", "t1", "needs", "WEB-1", "one"), session("s1", "t1", "needs", "WEB-2", "two"),
    session("s1", "t2", "stall", "WEB-3"), session("s1", "t1", "working", "WEB-4"),
    session("s1", "t1", "done", "WEB-5"), session("s2", "t9", "needs", "WEB-9"),
  ];
  assert.deepEqual(crewOf(sessions, "s1").counts, { needs: 2, stall: 1, working: 1, done: 1 });
  assert.equal(crewOf(sessions, "s1").total, 5);
  assert.deepEqual(crewOf(sessions, "s1", "t1").counts, { needs: 2, stall: 0, working: 1, done: 1 });
  assert.equal(crewOf(sessions, "s1").tip, "WEB-1 one, WEB-2 two, WEB-3, WEB-4, WEB-5");
  assert.deepEqual(crewOf(sessions, "s9"), { counts: { needs: 0, stall: 0, working: 0, done: 0 }, total: 0, tip: "" });
});

test("the crew's pills read ! n, + n, a spinner's n and ✓ n, most urgent first", () => {
  assert.deepEqual(crewPills({ needs: 2, stall: 1, working: 3, done: 4 }),
    [{ state: "needs", text: "! 2" }, { state: "stall", text: "+ 1" }, { state: "working", text: "3" }, { state: "done", text: "✓ 4" }]);
  assert.deepEqual(crewPills({ needs: 0, stall: 0, working: 1, done: 0 }), [{ state: "working", text: "1" }]);
  assert.deepEqual(crewPills({}), []);
});

test("the switcher's status icon is the crew's most urgent state, else idle", () => {
  assert.equal(statusOf({ needs: 0, stall: 1, working: 2, done: 0 }), "stall");
  assert.equal(statusOf({ needs: 1, stall: 1, working: 0, done: 0 }), "needs");
  assert.equal(statusOf({ needs: 0, stall: 0, working: 0, done: 1 }), "done");
  assert.equal(statusOf({ needs: 0, stall: 0, working: 0, done: 0 }), "idle");
});

test("a pitch with no crew says idle and its age, else that a shell is there", () => {
  const empty = crewOf([], "s1");
  assert.equal(idleText(empty, 1, [15 * MIN]), "idle 15m");
  assert.equal(idleText(empty, 1, [95 * MIN]), "idle 1h");
  assert.equal(idleText(empty, 1, []), "shell");
  assert.equal(idleText(empty, 0, []), null);
  assert.equal(idleText(crewOf([session("s1", "t1", "needs", "WEB-1")], "s1"), 1, [15 * MIN]), null,
    "a space with a crew shows the crew, not its shells");
});

test("only shell terminals that run no agent count as a space's shells", () => {
  const list = [{ address: "t1" }, { address: "t2" }];
  assert.equal(shellsIn([{ address: "t1", program: { shell: true } }, { address: "t3", program: { shell: true } }], list), 1);
  assert.equal(shellsIn([{ address: "t2", program: { shell: true } }], list), 0);
});

test("every repository heads a ground and the ma’veyyo space opens into one row per tab", () => {
  setRepoPrefixes(["shop"]);
  const shop = { common: "/Users/me/git-repo/shop/.git", base: false };
  const space = (id, name, tabs = [{ id: `${id}-tab`, name: "1", active: false }]) => ({ id, name, tabs, active: id === "s2" });
  const rows = [
    { space: space("s1", "web-1408-ai"), mine: [], tabOf: new Map(), repo: shop },
    { space: space("s2", "shop-api-WEB-1435"), mine: [], tabOf: new Map(), repo: shop },
    { space: space("s3", "herdr-fm27"), mine: [], tabOf: new Map(), repo: { common: "/Users/me/git-repo/herdr-fm27/.git", base: true } },
    { space: space("s4", "resumed", [{ id: "tb1", name: "mv-1791252016", active: true }, { id: "tb2", name: "mv-1793691052", active: false }]),
      mine: [{ address: "t90", cwd: "/Users/me/.claude/state/maveyyo-bot/sessions/C0EXAMPLE01-1791252016_169809" },
        { address: "t92", cwd: "/Users/me/.claude/state/maveyyo-bot/sessions/C0EXAMPLE01-1793691052_993259" }],
      tabOf: new Map([["t90", "tb1"], ["t92", "tb2"]]), repo: null },
  ];
  const sessions = [
    session("s1", "s1-tab", "done", "WEB-1408", "새 화면"),
    session("s2", "s2-tab", "needs", "WEB-1435", "api"), session("s2", "s2-tab", "done", "WEB-1435", "api"),
    session("s3", "s3-tab", "working", null, "herdr fm27"),
    session("s4", "tb1", "working", null, "새 상담"),
  ];
  const places = { s1: "web-1408-ai", s2: "shop-api-WEB-1435" };
  const groups = clubTree(rows, sessions, places);
  assert.deepEqual(groups.map((g) => g.head), ["shop", "herdr-fm27", "ma’veyyo"]);
  assert.deepEqual(groups[0].rows.map((r) => [r.name.key, r.name.rest]), [["WEB-1408", "ai"], ["WEB-1435", "api"]]);
  assert.equal(groups[0].base, false);
  assert.deepEqual(groups[0].rows[1].crew.counts, { needs: 1, stall: 0, working: 0, done: 1 });
  assert.deepEqual(groups[1].rows.map((r) => [r.name.key, r.name.rest, r.active]), [["base", "herdr-fm27", false]]);
  assert.equal(groups[1].base, true, "a home checkout marks the ground");
  assert.deepEqual(groups[2].rows.map((r) => [r.name.key, r.name.rest, r.tab.id]),
    [["새 상담", "mv-1791252016", "tb1"], [null, "mv-1793691052", "tb2"]],
    "a thread with no session still gets its row from the tab's shell");
  assert.equal(groups[2].rows[1].crew.total, 0);
});

test("a space outside every repository gets a ground named after its folder, after the repository grounds", () => {
  globalThis.herdrState = { home: "/Users/test" };
  try {
    assert.equal(folderLabel("/Users/test"), "~", "home reads as ~");
    assert.equal(folderLabel(""), "~", "an empty folder starts at home");
    assert.equal(folderLabel("/tmp/work/"), "work");
    assert.equal(folderLabel("/Users/test/notes"), "notes");
    const space = (id, name, folder) => ({ id, name, folder, tabs: [{ id: `${id}-tab`, name: "1", active: false }], active: false });
    const rows = [
      { space: space("r1", "herdr-fm27", "/Users/test/git/herdr-fm27"), mine: [], tabOf: new Map(),
        repo: { common: "/Users/test/git/herdr-fm27/.git", base: true } },
      { space: space("h1", "me", "/Users/test"), mine: [], tabOf: new Map(), repo: null },
      { space: space("w1", "work", "/tmp/work"), mine: [], tabOf: new Map(), repo: null },
    ];
    const groups = clubTree(rows, [], {});
    assert.deepEqual(groups.map((group) => [group.kind, group.head]), [["repo", "herdr-fm27"], ["folder", "~"], ["folder", "work"]]);
    assert.deepEqual(groups.flatMap((group) => group.rows.map((row) => row.space.id)).sort(), ["h1", "r1", "w1"],
      "every space appears");
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("groupOrder puts one repository's spaces together with its home checkout first", () => {
  const rows = [
    { space: { id: "a1" }, repo: { common: "/A/.git", base: false } },
    { space: { id: "b1" }, repo: { common: "/B/.git", base: true } },
    { space: { id: "a2" }, repo: { common: "/A/.git", base: true } },
    { space: { id: "solo" }, repo: null },
    { space: { id: "b2" }, repo: { common: "/B/.git", base: false } },
  ];
  assert.deepEqual(groupOrder(rows), ["a2", "a1", "b1", "b2", "solo"]);
  assert.deepEqual(groupOrder([{ space: { id: "solo" }, repo: null }, { space: { id: "a1" }, repo: { common: "/A/.git", base: false } }]),
    ["a1", "solo"], "a space outside every repository goes to the end, as on the Club screen");
});

test("the screen moves a home checkout ahead of its worktrees, once", () => {
  globalThis.herdrRuns = [];
  globalThis.herdrState = {
    spaces: [{ id: "w1", name: "web-1408-ai", tabs: [{ id: "w1-t" }] }, { id: "b1", name: "herdr-fm27", tabs: [{ id: "b1-t" }] }],
    terminals: [{ address: "t1", cwd: "/A/wt", program: {} }, { address: "t2", cwd: "/A", program: {} }],
    panes: [{ terminal: "t1", tab: "w1-t" }, { terminal: "t2", tab: "b1-t" }],
  };
  const v = new FMClub();
  v.role = "screen";
  v.repos = { "/A/wt": { common: "/A/.git", base: false }, "/A": { common: "/A/.git", base: true } };
  v.groupSpaces();
  assert.deepEqual(globalThis.herdrRuns, [["space.move", { id: "b1", index: 1 }]]);
  v.groupSpaces();
  assert.equal(globalThis.herdrRuns.length, 1, "the same order is not moved again");
});

test("a space dropped on another row of its ground moves there, and not across grounds", () => {
  globalThis.herdrRuns = [];
  globalThis.herdrState = { spaces: [{ id: "w1" }, { id: "b1" }, { id: "x1" }] };
  const v = new FMClub();
  const from = { space: { id: "w1" } };
  const to = { space: { id: "b1" } };
  const other = { space: { id: "x1" } };
  const groups = [{ rows: [from, to] }, { rows: [other] }];
  v.moveOnto(from, other, groups);
  assert.deepEqual(globalThis.herdrRuns, [], "another ground is not a drop target");
  v.moveOnto(from, to, groups);
  assert.deepEqual(globalThis.herdrRuns, [["space.move", { id: "w1", index: 2 }]]);
  assert.equal(v.at, 1, "the cursor follows the moved space");
});

test("a shell counts as idle from when its turn last changed", () => {
  const v = new FMClub();
  v.turns = {};
  const shell = { address: "t1", turn: 1, program: { shell: true } };
  assert.deepEqual(v.idleShells([shell], 1000), []);
  assert.deepEqual(v.idleShells([shell], 1000 + IDLE - 1), []);
  assert.deepEqual(v.idleShells([shell], 1000 + IDLE), [IDLE]);
  assert.deepEqual(v.idleShells([{ ...shell, turn: 2 }], 1000 + IDLE), [], "a new turn restarts the clock");
  assert.deepEqual(v.idleShells([{ address: "t2", turn: 1, program: { shell: false } }], 999999), []);
});

test("the club screen and the switcher draw the grounds with their crew's pills", () => {
  globalThis.herdrState = {
    spaces: [{ id: "s1", name: "shop-api-WEB-1435", tabs: [{ id: "s1-t", name: "1", active: true }], active: true }],
    terminals: [{ address: "t1", cwd: "/A/wt", program: {} }],
    panes: [{ terminal: "t1", tab: "s1-t" }],
    agents: [],
    shared: { "fm.squad": { places: { s1: "shop-api-WEB-1435" },
      sessions: [session("s1", "s1-t", "needs", "WEB-1435", "api")] } },
  };
  const v = new FMClub();
  Object.assign(v, { role: "screen", at: 0, keyboard: false, turns: {}, repos: { "/A/wt": { common: "/A/.git", base: false } } });
  assert.ok(v.render({}));
  v.role = "switcher";
  assert.ok(v.render({}));
});
