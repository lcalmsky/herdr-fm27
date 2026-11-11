// FM27 chrome: the window's top bar (history, club switcher, screen menu, Scout
// search, match reports, settings, the matchday box, Continue) and the sub bar
// below it (crumb, screen tabs, the notice pill, the keys legend). It only draws
// and sends commands; the session board itself belongs to fm-squad.
import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, spaces, props, shared, setShared, openOverlay, closeOverlay, layout, nextCommand } from "herdr";
import { C, FONT, FS, R, STATE, SCREENS, SCREEN_STACK, KEY } from "./tokens.js";

// The Keys button and the legend popup are two copies of this mod; the shared id
// is how the button knows the popup is already open.
export const KEYS_OPEN_KEY = "fm.keys-open";
const CLOCK_MS = 20_000;
const NO_TOUCHLINE = "Nothing on the touchline";
const WEEKDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// The legend lists exactly the keys keys.json gives this layout.
export const KEYS_LEGEND = [
  { label: "Select", keys: ["←", "→"] },
  { label: "Watch live", keys: ["↩"] },
  { label: "Phases", keys: ["↑", "↓"] },
  { label: "Sub off / rest", keys: ["⌫"] },
  { label: "Undo", keys: ["⌘", "Z"] },
  { label: "Continue", keys: ["Space"] },
  { label: "Next full time", keys: ["⇧", "Space"] },
  { label: "Dossier", keys: ["⌘", "↩"] },
  { label: "Next match report", keys: ["Tab"] },
  { label: "Back", keys: ["Esc"] },
  { label: "First / last", keys: ["⌥←", "⌥→"] },
  { label: "Match report", keys: ["⇧", "↩"] },
];

// keys.json section "layout:fm27" sends these to the chrome; the squad table does the work, so
// each one is forwarded as a single fm.cmd.
export const KEY_COMMANDS = ["toggle", "font_in", "font_out", "font_reset", "back", "forward"];

export function keyCommand(name) {
  return KEY_COMMANDS.includes(name) ? { name, args: {} } : null;
}

export function forwardKeyCommand(view, name) {
  const command = keyCommand(name);
  if (!command) return false;
  view.command(command.name, command.args);
  return true;
}

const token = () => `${Date.now()}-${Math.random()}`;

export function dateLabel(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${WEEKDAY[date.getDay()]} ${day}/${month}/${date.getFullYear()}`;
}

export function clockLabel(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Touchline is needs-you plus stoppages; that is the number the menu badge and
// the matchday box both show.
export function touchlineCount(counts = {}) {
  return (counts.needs ?? 0) + (counts.stall ?? 0);
}

export function menuBadge(screenId, counts = {}) {
  if (screenId !== "inbox") return null;
  const n = touchlineCount(counts);
  return n > 0 ? n : null;
}

export function continueLabel(cont) {
  if (!cont) return { text: "Continue", sub: NO_TOUCHLINE, enabled: false };
  const ticket = cont.ticket ?? cont.key ?? "This session";
  const mins = Number.isFinite(cont.mins) ? cont.mins : 0;
  return { text: "Continue", sub: `${ticket} on the touchline, ${mins} min`, enabled: true };
}

const SUB_TABS = {
  squad: (counts) => [
    { id: "all", label: "Overview" },
    { id: "attention", label: "Touchline", count: touchlineCount(counts), tone: "needs" },
    { id: "working", label: "In possession", count: counts.working ?? 0, tone: "working" },
    { id: "done", label: "Full time", count: counts.done ?? 0, tone: "done" },
  ],
  inbox: () => [
    { id: "all", label: "All" },
    { id: "touchline", label: "Touchline" },
    { id: "reports", label: "Match reports" },
  ],
};

export const INBOX_KINDS = ["all", "touchline", "reports"];
export const SQUAD_GROUPS = ["attention", "working", "done"];

export function subTabs(screenId, counts = {}) {
  const build = SUB_TABS[screenId];
  return build ? build(counts) : [];
}

// The top bar's budget, widest first: Continue (210) never shrinks, so each step down drops the
// widest thing that no longer fits — Scout 150, then 110, then its icon; the matchday box's second
// line, then the date, keeping the clock; the club switcher's name (capped at 200).
export const TOP_BAR_STEPS = [
  { min: 1520, scout: 150, date: "full", club: 200 },
  { min: 1480, scout: 110, date: "full", club: 200 },
  { min: 1410, scout: "icon", date: "full", club: 200 },
  { min: 1380, scout: "icon", date: "compact", club: 170 },
  { min: 1230, scout: "icon", date: "clock", club: 150 },
  { min: 0, scout: "icon", date: "clock", club: 90 },
];

export function topBarLayout(width) {
  const w = Number.isFinite(width) && width > 0 ? width : 1680;
  return TOP_BAR_STEPS.find((step) => w >= step.min);
}

export function noticeView(notice) {
  if (!notice?.text) return null;
  const tone = notice.tone === "err" ? "err" : "note";
  const action = notice.action ?? null;
  const act = action === "Retry" ? "retry" : action === "Undo" ? "undo" : null;
  const label = act === "undo" ? "Undo ⌘Z" : action;
  return { tone, text: notice.text, action, act, label };
}

export function groundName(space, places = {}) {
  return space ? places?.[space.id] ?? space.name : "Herdr";
}

export function groundSub(index, total) {
  return total > 0 ? `Ground ${index} of ${total}` : "No ground";
}

export function screenTitle(id) {
  return SCREENS.find((screen) => screen.id === id)?.title ?? "Squad";
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The stack's active child is the truth; fm.screen is the contract's copy of it.
export function currentScreen(tree, stored) {
  const active = find(tree, SCREEN_STACK)?.active;
  if (SCREENS.some((screen) => screen.id === active)) return active;
  return SCREENS.some((screen) => screen.id === stored) ? stored : "squad";
}

function fullRect() {
  return PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
}

// Buttons and rows sit in a window_drag block: every press has to be stopped or
// clicking them starts a window drag.
function gradientFill(angle, from, to) {
  return window.paint_path(fullRect(), Background.linear_gradient(angle, from, to)).absolute().top(0).left(0).size_full();
}

export default class FmChrome extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "top";
    if (this.role === "keys") {
      setShared(KEYS_OPEN_KEY, { id: props()?.overlay ?? null });
      return;
    }
    if (this.role === "sub") {
      this.sub = {};
      return;
    }
    this.handle = cx.focus_handle();
    this.editing = false;
    this.query = "";
    this.width = 0;
    // Both bars are shown copies; only the top bar listens, or every key command would run twice.
    cx.spawn(async (cx) => {
      for (;;) {
        if (!forwardKeyCommand(this, await nextCommand())) continue;
        cx.notify();
      }
    });
    this.clock = clockLabel(new Date());
    cx.timer.every(CLOCK_MS, (cx) => {
      const next = clockLabel(new Date());
      if (next === this.clock) return;
      this.clock = next;
      cx.notify();
    });
  }

  async close(_cx) {
    if (this.role === "keys") setShared(KEYS_OPEN_KEY, null);
  }

  command(name, args = {}) {
    setShared(KEY.cmd, { token: token(), name, args });
  }

  switchScreen(id, cx) {
    setShared(KEY.screen, id);
    run("layout.select", { stack: SCREEN_STACK, child: id });
    cx.notify();
  }

  pickSub(screenId, id, cx) {
    this.sub = { ...this.sub, [screenId]: id };
    // Overview clears the group filter; the three group tabs narrow the squad to it.
    if (screenId === "squad") this.command("filter", { group: id === "all" ? null : id });
    if (screenId === "inbox") this.command("inbox-filter", { kind: id });
    cx.notify();
  }

  toggleKeys(cx) {
    const open = shared(KEYS_OPEN_KEY);
    if (open?.id) {
      closeOverlay(open.id);
      setShared(KEYS_OPEN_KEY, null);
    } else {
      const id = openOverlay({ mod: "fm-chrome", props: { role: "keys" }, kind: "popup", frame: "none", width: 470, height: 300 });
      setShared(KEYS_OPEN_KEY, { id });
    }
    cx.notify();
  }

  searchKey(event) {
    if (!this.editing) return false;
    const m = event.modifiers ?? {};
    const plain = !m.platform && !m.control && !m.alt;
    if (event.key === "escape") {
      this.editing = false;
      this.query = "";
      this.command("search", { query: "" });
      this.handle.release();
      return true;
    }
    if (event.key === "enter") {
      this.editing = false;
      this.handle.release();
      return true;
    }
    if (event.key === "backspace" && plain) {
      if (event.is_held) return true;
      this.query = this.query.slice(0, -1);
      this.command("search", { query: this.query });
      return true;
    }
    if (event.key_char && event.key_char.length === 1 && plain) {
      this.query += event.key_char;
      this.command("search", { query: this.query });
      return true;
    }
    return false;
  }

  render(cx) {
    if (this.role === "keys") return this.keysLegend();
    if (this.role === "sub") return this.subBar(cx);
    return this.topBar(cx);
  }

  topBar(cx) {
    const squad = shared(KEY.squad) ?? {};
    const counts = squad.counts ?? {};
    const history = squad.history ?? {};
    const session = spaces().find((space) => space.active) ?? null;
    const index = session ? spaces().indexOf(session) + 1 : 0;
    const screen = currentScreen(layout(), shared(KEY.screen));
    const cont = continueLabel(squad.continue);
    const unread = squad.reports?.unread ?? 0;
    const now = new Date();
    const bar = topBarLayout(this.width);
    const stop = (_e, cx) => cx.stop_propagation();

    const navButton = (id, icon, enabled, act) => h_flex().id(id)
      .w(34).h(40).flex_none().items_center().justify_center().rounded(R.r1).bg(C.nav3)
      .opacity(enabled ? 1 : 0.45).transition("opacity", 180)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_mouse_down("left", stop)
      .on_click(() => { if (enabled) act(); })
      .tooltip(id === "back" ? "Back · ⌘[" : "Forward · ⌘]")
      .child(svg(`mods/fm-chrome/art/${icon}.svg`).size(14).text_color(C.navInk));

    const clubSwitch = h_flex().id("club-sw").h(44).flex_none().px(6).gap(8).items_center().rounded(R.r1)
      .transition("opacity", 180).cursor_pointer()
      .hover((s) => s.bg(C.veil2))
      .on_mouse_down("left", stop)
      // mod.open carries no props, so fm-club decides for itself to show the switcher as an overlay.
      .on_click(() => run("mod.open", { name: "fm-club" }))
      .tooltip("Switch ground")
      .child(image("mods/fm-chrome/art/crest.png").w(40).h(44))
      .when(bar.club > 0, (el) => el.child(v_flex().min_w(0).max_w(bar.club)
        .child(div().text_size(FS.h).font_family(FONT.display).font_weight(700).text_color(C.navInk).truncate()
          .child(groundName(session, squad.places).toUpperCase()))
        .child(div().text_size(FS.sm).font_family(FONT.body).font_weight(500).text_color(C.navInk).opacity(0.7).truncate()
          .child(groundSub(index, spaces().length)))))
      .child(svg("mods/fm-chrome/art/caret.svg").size(10).text_color(C.navInk).opacity(0.7));

    const menuItem = (entry) => {
      const current = entry.id === screen;
      const badge = menuBadge(entry.id, counts);
      return h_flex().id(`menu-${entry.id}`).h_full().px(14).gap(6).items_center().cursor_pointer()
        .opacity(current ? 1 : 0.78).transition("opacity", 180)
        .hover((s) => s.opacity(1))
        .role("tab").aria_selected(current)
        .on_mouse_down("left", stop)
        .on_click(() => this.switchScreen(entry.id, cx))
        .child(div().text_size(FS.h).font_family(FONT.display).font_weight(700).text_color(C.navInk)
          .child(entry.title.toUpperCase()))
        .when(Boolean(badge), (el) => el.child(div().min_w(18).h(18).px(5).rounded(R.pill).bg(C.needsFill)
          .flex().items_center().justify_center()
          .child(div().text_size(FS.xs).font_family(FONT.body).font_weight(800).text_color(C.paper).child(String(badge)))))
        .when(current, (el) => el.child(div().absolute().bottom(0).left(12).right(12).h(3).rounded_t(3).bg(C.navInk)));
    };

    const shown = this.editing ? this.query : String(squad.query ?? "");
    const scoutIcon = bar.scout === "icon";
    const searchBox = h_flex().id("scout").w(bar.scout).h(32).flex_none().items_center().rounded(R.r1)
      .bg(C.shade1).cursor_text().track_focus(this.handle).tab_index(0)
      .when(scoutIcon, (el) => el.justify_center()).when(!scoutIcon, (el) => el.px(12).gap(8))
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.editing = true;
        this.query = String(squad.query ?? "");
        this.handle.focus();
        cx.notify();
      })
      .on_key_down((event, cx) => {
        if (!this.searchKey(event)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(svg("mods/fm-chrome/art/search.svg").size(14).text_color(C.navInk).opacity(0.8))
      .when(!scoutIcon, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(FS.md).font_family(FONT.body)
        .text_color(C.navInk).opacity(shown ? 1 : 0.75).child(shown || "Scout")));

    const iconButton = (id, icon, act, tip) => h_flex().id(id).w(32).h(32).flex_none().items_center().justify_center()
      .rounded(R.r1).transition("opacity", 180).cursor_pointer().hover((s) => s.bg(C.veil2))
      .on_mouse_down("left", stop)
      .on_click(act)
      .tooltip(tip)
      .child(svg(`mods/fm-chrome/art/${icon}.svg`).size(17).text_color(C.navInk));

    const reports = iconButton("reports", "report", () => this.command("next-report"), `${unread} reports to read`)
      .when(unread > 0, (el) => el.child(div().absolute().top(1).right(0).min_w(16).h(16).px(4).rounded(R.pill)
        .bg(C.accent).flex().items_center().justify_center()
        .child(div().text_size(10).font_family(FONT.body).font_weight(700).text_color(C.accentInk).child(String(unread)))));

    const clockPill = div().h(22).px(6).rounded(3).bg(C.ink).flex().items_center()
      .child(div().text_size(FS.xl).font_family(FONT.display).font_weight(700).text_color(C.nav).child(this.clock));

    const dateBox = h_flex().id("matchday").h(44).flex_none().pl(12).pr(6).gap(10).items_center().rounded(R.r1).bg(C.shade2)
      .when(bar.date !== "clock", (el) => el.child(v_flex().min_w(0)
        .child(div().text_size(FS.lg).font_family(FONT.display).font_weight(700).text_color(C.navInk).child(dateLabel(now)))
        .when(bar.date === "full", (inner) => inner.child(div().text_size(FS.sm).font_family(FONT.body)
          .text_color(C.navInk).opacity(0.75).child(`${touchlineCount(counts)} on the touchline`)))))
      .child(clockPill);

    const continueButton = div().id("continue").w(210).h(44).flex_none().min_w(180).rounded(R.r1).overflow_hidden()
      .opacity(cont.enabled ? 1 : 0.45).transition("opacity", 180)
      .when(cont.enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.94)))
      .on_mouse_down("left", stop)
      .on_click(() => { if (cont.enabled) this.command("continue"); })
      .tooltip("Go to the longest touchline call, Space")
      .child(gradientFill(90, C.accent2, C.accent))
      .child(h_flex().h_full().flex_1().pl(18).pr(14).gap(14).items_center().justify_between()
        .child(v_flex().min_w(0)
          .child(div().text_size(FS.h).font_family(FONT.display).font_weight(700).text_color(C.accentInk).child(cont.text))
          .child(div().text_size(FS.sm).font_family(FONT.body).font_weight(600).text_color(C.accentInk).opacity(0.85)
            .truncate().child(cont.sub)))
        .child(svg("mods/fm-chrome/art/chev2.svg").size(20).text_color(C.accentInk)));

    return h_flex().id("fm-top").size_full().items_center().gap(14).pl(84).pr(12)
      .on_size_change((size, cx) => {
        if (size.width === this.width) return;
        this.width = size.width;
        cx.notify();
      })
      .child(h_flex().gap(6).items_center()
        .child(navButton("back", "left", Boolean(history.canBack), () => this.command("back")))
        .child(navButton("forward", "right", Boolean(history.canFwd), () => this.command("forward"))))
      .child(clubSwitch)
      .child(h_flex().id("main-menu").h_full().ml(6).items_center().children(SCREENS.map(menuItem)))
      .child(div().flex_1().min_w(0))
      .child(searchBox)
      .child(h_flex().gap(2).items_center()
        .child(reports)
        .child(iconButton("settings", "gear", () => run("app.settings"), "Settings")))
      .child(dateBox)
      .child(continueButton);
  }

  subBar(cx) {
    const squad = shared(KEY.squad) ?? {};
    const counts = squad.counts ?? {};
    const screen = currentScreen(layout(), shared(KEY.screen));
    const tabs = subTabs(screen, counts);
    // The inbox's own chips write the same kind back through fm.squad; adopt a change made there,
    // while this bar's own click still highlights at once.
    const publishedKind = INBOX_KINDS.includes(squad.inboxFilter) ? squad.inboxFilter : null;
    if (publishedKind && publishedKind !== this.seenPublishedKind) {
      this.seenPublishedKind = publishedKind;
      this.sub = { ...(this.sub ?? {}), inbox: publishedKind };
    }
    // The squad clears its group filter on Esc; a null there means Overview is active again.
    const publishedGroup = SQUAD_GROUPS.includes(squad.groupFilter) ? squad.groupFilter : null;
    if (publishedGroup !== this.seenPublishedGroup) {
      this.seenPublishedGroup = publishedGroup;
      this.sub = { ...(this.sub ?? {}), squad: publishedGroup ?? "all" };
    }
    const active = this.sub?.[screen] ?? tabs[0]?.id ?? null;
    const notice = noticeView(shared(KEY.notice));
    const keysOpen = Boolean(shared(KEYS_OPEN_KEY));
    const stop = (_e, cx) => cx.stop_propagation();

    const subtab = (tab) => {
      const on = tab.id === active;
      return h_flex().id(`subtab-${screen}-${tab.id}`).h_full().px(10).gap(6).items_center().cursor_pointer()
        .text_color(on ? C.ink : C.ink2).hover((s) => s.text_color(C.ink))
        .role("tab").aria_selected(on)
        .on_mouse_down("left", stop)
        .on_click(() => this.pickSub(screen, tab.id, cx))
        .child(div().text_size(FS.md).font_family(FONT.body).font_weight(on ? 700 : 500).child(tab.label))
        .when(tab.count !== undefined, (el) => el.child(div().text_size(FS.md).font_family(FONT.body).font_weight(700)
          .text_color(STATE[tab.tone].color).child(String(tab.count))))
        .when(on, (el) => el.child(div().absolute().bottom(6).left(8).right(8).h(2).bg(C.ink)));
    };

    const noticePill = (n) => h_flex().id("notice").h(26).flex_none().max_w(420).min_w(0)
      .pl(12).pr(n.label ? 4 : 12).gap(8).items_center().rounded(R.pill)
      .bg(n.tone === "err" ? `${C.needs}38` : C.panel3)
      .child(div().min_w(0).truncate().text_size(FS.base).font_family(FONT.body).font_weight(600)
        .text_color(n.tone === "err" ? C.ink : C.ink2).child(n.text))
      .when(Boolean(n.label), (el) => el.child(h_flex().id("notice-act").h(20).flex_none().px(9).items_center()
        .rounded(R.pill).bg(C.ink).cursor_pointer()
        .on_mouse_down("left", stop)
        .on_click(() => { if (n.act) setShared(KEY.noticeAct, { token: token(), act: n.act }); })
        .child(div().text_size(FS.sm).font_family(FONT.body).font_weight(700).text_color(C.bg).child(n.label))));

    const keysButton = h_flex().id("keys-btn").h(26).flex_none().px(10).gap(6).items_center().rounded(R.r1)
      .bg(keysOpen ? C.panel3 : C.panel2).border(1).border_color(C.line).cursor_pointer()
      .hover((s) => s.bg(C.panel3))
      .on_mouse_down("left", stop)
      .on_click(() => this.toggleKeys(cx))
      .child(div().text_size(FS.base).font_family(FONT.body).text_color(C.ink).child("Keys"))
      .child(div().text_size(FS.xs).font_family(FONT.body).font_weight(700).text_color(C.ink3).child("?"));

    return h_flex().size_full().items_center().gap(4).px(12)
      .child(div().flex_none().pr(14).text_size(FS.md).font_family(FONT.body).font_weight(700).text_color(C.ink)
        .child(screenTitle(screen)))
      .when(tabs.length > 0, (el) => el.child(div().w(1).h(22).flex_none().mr(6).bg(C.line)))
      .children(tabs.map(subtab))
      .child(div().flex_1().min_w(0))
      .when(Boolean(notice), (el) => el.child(noticePill(notice)))
      .child(keysButton);
  }

  keysLegend() {
    const cap = (key) => div().min_w(22).h(22).px(6).rounded(R.r1).bg(C.panel3).border(1).border_color(C.line2)
      .flex().items_center().justify_center()
      .child(div().text_size(FS.sm).font_family(FONT.body).font_weight(700).text_color(C.ink).child(key));
    const row = (entry) => h_flex().h(32).items_center().justify_between().gap(10)
      .border_b(1).border_color(C.line)
      .child(div().text_size(FS.base).font_family(FONT.body).text_color(C.ink2).child(entry.label))
      .child(h_flex().gap(3).children(entry.keys.map(cap)));
    const column = (rows) => v_flex().flex_1().min_w(0).children(rows.map(row));
    const left = KEYS_LEGEND.filter((_entry, i) => i % 2 === 0);
    const right = KEYS_LEGEND.filter((_entry, i) => i % 2 === 1);
    return v_flex().size_full().bg(C.panelSolid).border(1).border_color(C.line2).rounded(R.r2)
      .overflow_hidden().shadow_lg()
      .child(div().h(44).flex_none().overflow_hidden()
        .child(gradientFill(180, C.nav2, C.nav))
        .child(h_flex().h_full().px(16).gap(10).items_center()
          .child(div().text_size(FS.h).font_family(FONT.display).font_weight(700).text_color(C.navInk).child("KEYS"))
          .child(div().flex_1())
          .child(cap("?"))))
      .child(h_flex().flex_1().min_h(0).gap(18).px(16).py(10)
        .child(column(left))
        .child(column(right)));
  }
}
