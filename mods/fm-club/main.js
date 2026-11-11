// FM27 club: every git repository is a ground and every space a pitch in it. The screen draws
// grounds as cards, one row per space (ma’veyyo: one row per tab) with the crew's status counts;
// a click picks the space, a drag (or ⌥↑/⌥↓) reorders it inside its ground, a right-click opens
// Herdr's space menu. props().role "switcher" is the compact dropdown the chrome opens from the
// club switcher. Spaces cut from one repository are moved together (space.move) so ⌃1–9 follow
// the grounds.

import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, terminals, panes, exec, run, openOverlay, closeOverlay, props, shared, home, appHome, readTextFile } from "herdr";
import { C, FONT, FS, R, KEY } from "./tokens.js";

const IDLE_MS = 10 * 60 * 1000;
const REPO_MS = 30 * 1000;
const FOCUS_WATCH_MS = 100;
const SPACE_KEY = /(?:^|[^A-Za-z0-9])((?:cas|imio|ieis|web)-\d{1,5})(?![0-9])/i;
const MAVEYYO_SESSIONS = "/.claude/state/maveyyo-bot/sessions/";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RANK = { needs: 0, stall: 1, working: 2, done: 3 };
const HEAD_H = 38;
const ROW_H = 34;

const FOCUS_WASH = `${C.focusKb}14`;
const WORKING_WASH = `${C.working}38`;

const wash = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%")
  .line_to("0%", "100%").close().build();

// Where a terminal's program runs now; the recorded cwd is only where the terminal opened.
export function cwdOf(t) {
  return t?.foreground?.cwd || t?.cwd || null;
}

function quiet(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

// Repo prefixes come from `${appHome()}/fm27.json` "repos", the same file fm-squad reads.
let repoPrefixes = [];
export function setRepoPrefixes(list) {
  repoPrefixes = Array.isArray(list) ? list.filter((repo) => typeof repo === "string" && repo.trim()).map((repo) => repo.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : [];
}

// A space the sessions hold no label for is named from its own name.
export function spaceName(name, repos = repoPrefixes) {
  const text = String(name ?? "");
  const match = text.match(SPACE_KEY);
  if (!match) return { key: null, rest: text };
  const rest = text.replace(match[1], " ").replace(repos.length ? new RegExp(`^\\s*(?:${repos.join("|")})-`, "i") : /$^/, "")
    .replace(/(^|-)rd-\d{8}-\d{6}(?=-|$)/, "$1").replace(/(^|-)(?=[0-9a-f]*[a-f])[0-9a-f]{6}(?=-|$)/, "$1")
    .split(/[\s-]+/).filter(Boolean).join("-");
  return { key: match[1].toUpperCase(), rest: rest || null };
}

// The squad's place for a space is a label string, or the cards' { key, rest } shape.
function placeName(place) {
  if (place && typeof place === "object") {
    if ("key" in place || "rest" in place) return { key: place.key ?? null, rest: place.rest ?? null };
    if (typeof place.label === "string") return spaceName(place.label);
    return null;
  }
  return typeof place === "string" ? spaceName(place) : null;
}

// A ground's home checkout is its first pitch and reads "base" over its space name.
export function rowName(label, base = false) {
  const name = placeName(label) ?? { key: null, rest: null };
  if (!name.key && base && name.rest !== "base") return { key: "base", rest: name.rest };
  return name;
}

// A space outside every repository still needs a ground: its folder's name, "~" at home.
export function folderLabel(folder) {
  const text = String(folder ?? "").replace(/\/+$/, "");
  const root = String(home() ?? "").replace(/\/+$/, "");
  if (!text || (root && text === root)) return "~";
  return text.split("/").filter(Boolean).pop() ?? text;
}

// A space's crew: how many of its sessions wait for you, stall, work or are done.
export function crewOf(sessions, spaceId, tab = null) {
  const mine = sessions.filter((s) => s.space === spaceId && (!tab || s.tab === tab));
  const counts = { needs: 0, stall: 0, working: 0, done: 0 };
  for (const s of mine) if (counts[s.state] != null) counts[s.state] += 1;
  const tip = mine.map((s) => [s.key, s.title].filter(Boolean).join(" ") || s.ticket).filter(Boolean).join(", ");
  return { counts, total: mine.length, tip };
}

// The crew's small status pills, most urgent first: "! 1", "+ 1", a spinner and its count, "✓ 1".
export function crewPills(counts) {
  const pills = [];
  if (counts?.needs) pills.push({ state: "needs", text: `! ${counts.needs}` });
  if (counts?.stall) pills.push({ state: "stall", text: `+ ${counts.stall}` });
  if (counts?.working) pills.push({ state: "working", text: String(counts.working) });
  if (counts?.done) pills.push({ state: "done", text: `✓ ${counts.done}` });
  return pills;
}

// The one state a space leads with in the switcher: the most urgent of its crew, else idle.
export function statusOf(counts) {
  return Object.keys(RANK).find((state) => counts?.[state] > 0) ?? "idle";
}

// A pitch with no crew says what its shells are doing: an idle one's age, else that a shell is there.
export function idleText(crew, shells, idleAges = []) {
  if (crew.total > 0) return null;
  if (idleAges.length > 0) return `idle ${quiet(Math.max(...idleAges))}`;
  return shells > 0 ? "shell" : null;
}

// Shell terminals in a space that run no agent.
export function shellsIn(mine, list) {
  const agentAddresses = new Set(list.map((a) => a.address));
  return mine.filter((t) => t.program?.shell && !agentAddresses.has(t.address)).length;
}

// The grounds, grouped. `rows` are spaceRows() in Herdr's order, `sessions` the squad's list and
// `places` its { [space id]: label }. Every repository gets a ground headed by its name; a space
// with no label is named from its own name, and one named like its repository shows its session
// instead. A space whose terminals run Maveyyo threads becomes one ground of thread rows.
export function clubTree(rows, sessions = [], places = {}) {
  const groups = [];
  const byKey = new Map();
  for (const row of rows) {
    const s = row.space;
    const here = sessions.filter((x) => x.space === s.id);
    const maveyyo = row.mine.length > 0
      && row.mine.every((t) => String(cwdOf(t) ?? "").includes(MAVEYYO_SESSIONS));
    if (maveyyo) {
      const tabs = s.tabs.map((tab) => ({
        tab,
        crew: here.filter((x) => x.tab === tab.id),
        mine: row.mine.filter((t) => row.tabOf?.get(t.address) === tab.id),
      })).filter((t) => t.crew.length > 0 || t.mine.length > 0);
      groups.push({ head: "ma’veyyo", kind: "maveyyo", base: false, rows: tabs.map(({ tab, crew, mine }) => {
        const title = crew.map((c) => c.title).find(Boolean);
        return { id: tab.id, space: s, tab, crew: crewOf(sessions, s.id, tab.id), title, mine,
          active: s.active && tab.active,
          name: title ? { key: title, rest: tab.name } : { key: null, rest: tab.name } };
      }) });
      continue;
    }
    const folder = row.space.folder ?? cwdOf(row.mine[0]) ?? null;
    const key = row.repo?.common ?? `folder:${folder ?? s.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = { head: row.repo?.common ? null : folderLabel(folder),
        kind: row.repo?.common ? "repo" : "folder", common: row.repo?.common ?? null, base: false, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (row.repo?.base) group.base = true;
    group.rows.push({ id: s.id, space: s, tab: null, crew: crewOf(sessions, s.id), mine: row.mine,
      title: here.map((c) => c.title).find(Boolean), active: s.active, base: Boolean(row.repo?.base),
      name: rowName(places[s.id] ?? s.name, Boolean(row.repo?.base)) });
  }
  for (const group of groups) {
    if (group.kind !== "repo") continue;
    group.head = group.common.replace(/\/\.git\/?$/, "").split("/").pop() || null;
    for (const entry of group.rows) {
      if (entry.name.key || entry.base || entry.name.rest !== group.head) continue;
      entry.name = { key: null, rest: entry.title ?? entry.name.rest };
    }
  }
  // Spaces outside a repository sit after the grounds that have one.
  return [...groups.filter((group) => group.kind !== "folder"), ...groups.filter((group) => group.kind === "folder")];
}

// Herdr's space order with each repository's spaces together and the home checkout first.
export function groupOrder(rows) {
  const groups = new Map();
  const loose = [];
  for (const row of rows) {
    const key = row.repo?.common;
    if (!key) { loose.push(row); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups.values()].flatMap((members) =>
    [...members.filter((r) => r.repo?.base), ...members.filter((r) => !r.repo?.base)]).map((r) => r.space.id);
  // Spaces outside a repository go after the grounds that have one, as they do on the Club screen.
  return [...ordered, ...loose.map((r) => r.space.id)];
}

// A rail key: ↑↓ move to the neighbouring row and wrap; ↩ and Space pick the row shown.
export function railKey(key, at, count) {
  if (!(count > 0)) return null;
  if (key === "down") return { at: (at + 1) % count, select: false };
  if (key === "up") return { at: (at - 1 + count) % count, select: false };
  if (key === "enter" || key === "space") return { at: Math.min(at, count - 1), select: true };
  return null;
}

export default class FMClub extends View {
  init(_props, cx) {
    cx.spawn(async (later) => {
      try {
        setRepoPrefixes(JSON.parse(await readTextFile(`${appHome()}/fm27.json`))?.repos);
      } catch {
        setRepoPrefixes([]);
      }
      later.notify();
    });
    const p = props() ?? {};
    this.role = p.role ?? (p.overlay ? "switcher" : "screen");
    this.keyboard = false;
    this.at = 0;
    this.press = null;
    this.turns = {};
    this.repos = {};
    this.reading = false;
    this.handle = cx.focus_handle();
    if (this.role === "screen") this.btnHandles = [cx.focus_handle(), cx.focus_handle()];
    cx.timer.every(REPO_MS, (cx) => this.readRepos(cx));
    if (this.role === "screen") {
      cx.timer.every(30000, (cx) => cx.notify());
      cx.timer.every(FOCUS_WATCH_MS, (cx) => this.watchFocus(cx));
    }
    this.readRepos(cx);
  }

  focusKey() {
    const handles = [this.handle, ...(this.btnHandles ?? [])];
    return `${this.keyboard ? 1 : 0}|${handles.map((handle) => (handle?.is_focused?.() ? 1 : 0)).join("")}`;
  }

  // A focus cue comes from is_focused(), which the shell does not redraw on; only the keyboard
  // draws it, since a click focuses the screen too.
  watchFocus(cx) {
    const key = this.focusKey();
    if (key === this.drawnFocus) return;
    this.drawnFocus = key;
    cx.notify();
  }

  // SpaceInfo.folder is where new terminals start, not where they are, so the repo comes from
  // where a terminal's program runs now (cwdOf).
  readRepos(cx) {
    if (this.reading) return;
    this.reading = true;
    const folders = [...new Set(terminals().map(cwdOf).filter(Boolean))];
    cx.spawn(async (later) => {
      const next = {};
      for (const cwd of folders) {
        try {
          const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
          const [common, top] = String(r.stdout ?? "").trim().split("\n");
          next[cwd] = r.code === 0 && common ? { common, base: Boolean(top) && `${top}/.git` === common } : null;
        } catch {
          next[cwd] = null;
        }
      }
      this.repos = next;
      this.reading = false;
      this.groupSpaces();
      later.notify();
    });
  }

  // Each space's terminals, the tab each one is in, and the repository git found at its first cwd;
  // repo is undefined while git hasn't been asked about that cwd yet.
  spaceRows() {
    const byAddress = new Map(terminals().map((t) => [t.address, t]));
    const paneList = panes();
    return spaces().map((s) => {
      const tabs = new Set(s.tabs.map((t) => t.id));
      const mine = paneList.filter((p) => p.terminal && tabs.has(p.tab))
        .map((p) => byAddress.get(p.terminal)).filter(Boolean);
      const tabOf = new Map(paneList.filter((p) => p.terminal && tabs.has(p.tab))
        .map((p) => [p.terminal, p.tab]));
      const cwd = mine.map(cwdOf).find(Boolean) ?? null;
      return { space: s, mine, tabOf, repo: cwd ? this.repos[cwd] : null };
    });
  }

  // Keeps the spaces of one repository next to each other in Herdr's own order (base checkout
  // first), so ⌃1–9 follow the grounds. Each order is tried once.
  groupSpaces() {
    const rows = this.spaceRows();
    if (rows.some((row) => row.repo === undefined)) return;
    const have = rows.map((r) => r.space.id);
    const want = groupOrder(rows);
    const key = `${have.join(",")}>${want.join(",")}`;
    if (want.join(",") === have.join(",") || this.lastMove === key) return;
    this.lastMove = key;
    const order = [...have];
    want.forEach((id, index) => {
      if (order[index] === id) return;
      run("space.move", { id, index: index + 1 });
      order.splice(order.indexOf(id), 1);
      order.splice(index, 0, id);
    });
  }

  // hc gives no last-activity time, so a shell counts as idle from when this view last saw its turn change.
  idleShells(list, now) {
    const idle = [];
    for (const t of list) {
      if (!t.program?.shell) continue;
      const seen = this.turns[t.address];
      if (!seen || seen.turn !== t.turn) this.turns[t.address] = { turn: t.turn, at: now };
      const since = now - this.turns[t.address].at;
      if (since >= IDLE_MS) idle.push(since);
    }
    return idle;
  }

  tree() {
    const now = Date.now();
    const squad = shared(KEY.squad) ?? {};
    const rows = this.spaceRows().map((row) => ({ ...row, repo: row.repo ?? null }));
    const groups = clubTree(rows, squad.sessions ?? [], squad.places ?? {});
    return { groups, order: groups.flatMap((group) => group.rows), now };
  }

  select(entry) {
    this.keyboard = true;
    run("space.select", { id: entry.space.id });
    if (entry.tab) run("tab.select", { id: entry.tab.id });
  }

  choose(entry) {
    this.select(entry);
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // Moves a space onto another row of its own ground, in Herdr's 1-based space order.
  moveOnto(from, to, groups) {
    const group = groups.find((g) => g.rows.includes(from) && g.rows.includes(to));
    if (!group || from.space.id === to.space.id) return;
    const index = spaces().findIndex((s) => s.id === to.space.id) + 1;
    if (index < 1) return;
    run("space.move", { id: from.space.id, index });
    this.at = groups.flatMap((g) => g.rows).indexOf(to);
  }

  // ⌥↑/⌥↓ move the highlighted space one row inside its ground.
  moveStep(entry, delta, groups) {
    const group = groups.find((g) => g.rows.includes(entry));
    if (!group) return false;
    const to = group.rows[group.rows.indexOf(entry) + delta];
    if (!to) return false;
    this.moveOnto(entry, to, groups);
    return true;
  }

  render(cx) {
    const tree = this.tree();
    this.at = Math.min(Math.max(this.at ?? 0, 0), Math.max(0, tree.order.length - 1));
    this.drawnFocus = this.focusKey();
    return this.role === "switcher" ? this.switcher(cx, tree) : this.screen(cx, tree);
  }

  // ── shared pieces ──────────────────────────────────────────────────────────

  nameLabel(entry, lit) {
    const keyColor = lit ? C.focusKb : C.ink;
    return h_flex().flex_1().min_w(0).gap(6).items_center()
      .when(Boolean(entry.name.key), (el) => el.child(div().flex_none().text_size(FS.base).font_weight(700)
        .text_color(keyColor).child(entry.name.key)))
      .when(Boolean(entry.name.rest), (el) => el.child(div().min_w(0).truncate().text_size(FS.base)
        .text_color(entry.name.key ? C.ink2 : keyColor).child(entry.name.rest)));
  }

  crewPill(pill) {
    const box = () => h_flex().h(20).flex_none().rounded(R.r2).px(6).gap(4).items_center()
      .text_size(FS.xs).font_weight(700);
    if (pill.state === "working") {
      return box().bg(WORKING_WASH).text_color(C.working)
        .child(div().frames(SPIN, 90)).child(pill.text);
    }
    return box()
      .when(pill.state === "needs", (el) => el.bg(C.needsFill).text_color(C.paper))
      .when(pill.state === "stall", (el) => el.bg(C.stall).text_color(C.bg))
      .when(pill.state === "done", (el) => el.bg(C.panel3).text_color(C.done))
      .child(pill.text);
  }

  idlePill(text) {
    return div().h(20).flex_none().rounded(R.r1).px(6).flex().items_center()
      .border(1).border_dashed().border_color(C.line2).text_size(FS.xs).text_color(C.ink3).child(text);
  }

  // The crew column of a pitch: status pills, or what its shells are doing when no one is in it.
  crewColumn(entry, shells, idleAges) {
    const crew = entry.crew;
    const idle = idleText(crew, shells, idleAges);
    return h_flex().flex_none().gap(4).items_center()
      .children(crewPills(crew.counts).map((pill) => this.crewPill(pill)))
      .when(Boolean(idle), (el) => el.child(this.idlePill(idle)));
  }

  tipOf(entry, shells, idleAges) {
    const crew = entry.crew;
    const who = crewPills(crew.counts).map((pill) => `${pill.state} ${pill.text.replace(/^[!+✓] /, "")}`).join(", ");
    const idle = idleText(crew, shells, idleAges);
    return [entry.name.key ? `${entry.name.key} ${entry.name.rest ?? ""}`.trim() : entry.name.rest,
      crew.tip, who, shells ? `${shells} shell${shells === 1 ? "" : "s"}` : null, idle]
      .filter(Boolean).join(" · ");
  }

  cursorBar() {
    return div().absolute().top(0).bottom(0).left(0).w(3).bg(C.focusKb);
  }

  // ── screen ─────────────────────────────────────────────────────────────────

  screen(cx, tree) {
    const { groups, order, now } = tree;
    const agentList = agents();
    const focusedAt = (entry) => this.keyboard && Boolean(this.handle?.is_focused?.()) && order[this.at] === entry;

    const groundCard = (group) => {
      const pill = group.kind === "maveyyo" ? "one row per tab" : group.base ? "home pitch first" : null;
      return v_flex().flex_1().min_w(0).rounded(R.r3).border(1).border_color(C.lineSoft)
        .bg(C.panel2).overflow_hidden()
        .child(h_flex().relative().h(HEAD_H).flex_none().items_center().gap(8).px(12)
          .child(window.paint_path(wash(), Background.linear_gradient(180, C.nav2, C.nav))
            .absolute().top(0).left(0).size_full())
          .child(div().min_w(0).truncate().text_size(FS.xl).font_family(FONT.display).font_weight(700)
            .text_color(C.navInk).child(group.head ?? ""))
          .child(div().flex_1())
          .when(Boolean(pill), (el) => el.child(div().h(20).flex_none().rounded(R.r1).px(6)
            .bg(C.shade3).text_size(FS.xs).font_weight(700).text_color(C.veilInk).child(pill))))
        .children(group.rows.map((entry, index) => this.pitchRow(entry, index, groups, order, agentList, now, focusedAt)));
    };

    const cards = groups.map((group) => groundCard(group));
    const grid = [];
    for (let at = 0; at < cards.length; at += 3) {
      const line = cards.slice(at, at + 3);
      while (line.length < 3) line.push(div().flex_1().min_w(0));
      grid.push(h_flex().flex_none().items_start().gap(10).children(line));
    }

    return v_flex().size_full().min_h(0)
      .child(h_flex().flex_none().items_center().gap(10).px(18).pt(14).pb(10)
        .child(div().flex_none().text_size(FS.h).font_family(FONT.display).font_weight(700).text_color(C.ink).child("CLUB"))
        .child(div().min_w(0).truncate().text_size(FS.sm).text_color(C.ink3)
          .child("every repository is a ground, every space a pitch in it"))
        .child(div().flex_1())
        .child(this.headButton(0, "club-new", "New space", "mods/fm-club/icons/plus.svg", () => run("space.new")))
        .child(this.headButton(1, "club-settings", "Settings", "mods/fm-club/icons/settings.svg", () => run("app.settings"))))
      .child(v_flex().flex_1().min_h(0).px(12).pb(12).gap(10).overflow_y_scroll()
        .track_focus(this.handle).tab_index(0)
        .on_mouse_down("left", () => { this.keyboard = false; })
        .on_mouse_up("left", () => { this.press = null; })
        .on_key_down((event, cx) => {
          if (event.modifiers.alt && (event.key === "up" || event.key === "down")) {
            if (!this.moveStep(order[this.at], event.key === "up" ? -1 : 1, groups)) return;
            this.keyboard = true;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          const next = railKey(event.key, this.at, order.length);
          if (!next) return;
          this.keyboard = true;
          this.at = next.at;
          if (next.select) this.select(order[this.at]);
          cx.stop_propagation();
          cx.notify();
        })
        .children(grid));
  }

  pitchRow(entry, index, groups, order, agentList, now, focusedAt) {
    const shells = shellsIn(entry.mine, agentList);
    const idleAges = this.idleShells(entry.mine, now);
    const cursor = focusedAt(entry);
    const lit = entry.active || cursor;
    return h_flex().id(`club-${entry.id}`).relative().h(ROW_H).flex_none().items_center().gap(8).px(12)
      .cursor_pointer().role("row").aria_selected(Boolean(entry.active))
      .when(index % 2 === 1, (el) => el.bg(C.rowAlt))
      .when(entry.active, (el) => el.bg(FOCUS_WASH))
      .when(cursor, (el) => el.bg(C.panel3))
      .hover((h) => h.bg(C.veil1))
      .when(lit, (el) => el.child(this.cursorBar()))
      .tooltip(this.tipOf(entry, shells, idleAges))
      .on_mouse_down("left", (_event, cx) => { cx.stop_propagation(); this.press = entry; })
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260,
        props: { tab: "space", target: { id: entry.space.id } } }))
      .on_mouse_up("left", () => {
        const from = this.press;
        this.press = null;
        if (from && from !== entry) {
          this.moveOnto(from, entry, groups);
          return;
        }
        this.at = order.indexOf(entry);
        this.select(entry);
      })
      .child(this.nameLabel(entry, lit))
      .child(this.crewColumn(entry, shells, idleAges));
  }

  // New space and Settings keep the old bottom block's keyboard: each takes focus and ↩/Space.
  headButton(index, id, label, icon, action) {
    const handle = this.btnHandles?.[index];
    const focused = Boolean(this.keyboard && handle?.is_focused?.());
    const ink = focused ? C.focusKb : C.ink2;
    return h_flex().id(id).h(36).flex_none().items_center().gap(7).px(12).rounded(R.r2)
      .border(1).border_color(focused ? C.line2 : C.lineSoft).bg(focused ? C.panel3 : C.panel2).cursor_pointer()
      .role("button").accessibility_label(label)
      .hover((h) => h.bg(C.panel3).border_color(C.line2))
      .when(Boolean(handle), (el) => el.track_focus(handle).tab_index(0))
      .on_key_down((event, cx) => {
        if (event.key !== "enter" && event.key !== "space") return;
        this.keyboard = true;
        cx.stop_propagation();
        action();
        cx.notify();
      })
      .on_click(() => { this.keyboard = true; action(); })
      .child(svg(icon).size(14).text_color(ink))
      .child(div().text_size(FS.base).font_weight(600).text_color(ink).child(label));
  }

  // ── switcher ───────────────────────────────────────────────────────────────

  switcher(cx, tree) {
    const { groups, order } = tree;
    const agentList = agents();
    const cursorAt = (entry) => this.keyboard && Boolean(this.handle?.is_focused?.()) && order[this.at] === entry;

    const icon = (entry) => {
      const state = statusOf(entry.crew.counts);
      const box = () => div().size(20).flex_none().rounded(R.r2).flex().items_center().justify_center()
        .text_size(FS.xs).font_weight(700);
      if (state === "working") return box().bg(WORKING_WASH).text_color(C.working).child(div().frames(SPIN, 90));
      return box()
        .when(state === "needs", (el) => el.bg(C.needsFill).text_color(C.paper).child("!"))
        .when(state === "stall", (el) => el.bg(C.stall).text_color(C.bg).child("+"))
        .when(state === "done", (el) => el.bg(C.panel3).text_color(C.done).child("✓"))
        .when(state === "idle", (el) => el.text_color(C.ink3).child("·"));
    };

    const item = (entry) => {
      const cursor = cursorAt(entry);
      return h_flex().id(`dd-${entry.id}`).relative().h(ROW_H).flex_none().items_center().gap(8).px(8)
        .rounded(R.r1).cursor_pointer().role("row").aria_selected(Boolean(entry.active))
        .when(entry.active, (el) => el.bg(C.panel3))
        .when(cursor, (el) => el.bg(C.panel3))
        .hover((h) => h.bg(C.veil1))
        .when(entry.active || cursor, (el) => el.child(this.cursorBar()))
        .tooltip(this.tipOf(entry, shellsIn(entry.mine, agentList), []))
        .on_click(() => { this.at = order.indexOf(entry); this.choose(entry); })
        .child(this.nameLabel(entry, entry.active || cursor))
        .child(icon(entry));
    };

    return v_flex().size_full().min_h(0).p(6).overflow_y_scroll()
      .track_focus(this.handle).tab_index(0)
      .on_mouse_down("left", () => { this.keyboard = false; })
      .on_key_down((event, cx) => {
        const next = railKey(event.key, this.at, order.length);
        if (!next) return;
        this.keyboard = true;
        this.at = next.at;
        if (next.select) this.choose(order[this.at]);
        cx.stop_propagation();
        cx.notify();
      })
      .children(groups.flatMap((group) => [
        div().flex_none().px(8).pt(8).pb(4).text_size(FS.sm).font_weight(700).text_color(C.ink3)
          .child(group.head ?? "Ground"),
        ...group.rows.map(item),
      ]));
  }
}
