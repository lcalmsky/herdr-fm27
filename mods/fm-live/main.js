// Modified from Herdr's shipped `tabs` mod (0.1.12, Apache License 2.0, see LICENSE in this folder) and
// its `pane` header mod: one FM27 mod with a `tabs` role and a `pane` role.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, props, run, openOverlay, shared, layout, home, window } from "herdr";
import { C, FONT, FS, R } from "./tokens.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const FOCUS_WATCH_MS = 100;
const TRANSPARENT = "#00000000";
const LETTER = { claude: "C", codex: "X", gemini: "G" };

// Linux and Windows draw their own title bar, so the tab bar carries the window buttons there.
export function windowButtons() {
  const w = window();
  if (!w?.buttons) return [];
  const win = w.platform === "windows";
  return [
    { id: "minimize", label: "Minimize", command: "window.minimize", icon: win ? "win-min" : null, glyph: win ? null : "−", size: 16 },
    { id: "maximize", label: w.maximized ? "Restore" : "Maximize", command: "window.maximize",
      icon: win ? (w.maximized ? "win-restore" : "win-max") : null, glyph: win ? null : "□", size: 16 },
    { id: "close-window", label: "Close window", command: "window.close", icon: win ? "win-close" : "close", glyph: null, size: win ? 16 : 13 },
  ];
}

// A tab-bar key: ←→ move to the neighbouring tab and wrap; ↩ and Space select the tab shown.
export function tabsKey(key, at, count) {
  if (!(count > 0)) return null;
  if (key === "right") return { at: (at + 1) % count, select: false };
  if (key === "left") return { at: (at - 1 + count) % count, select: false };
  if (key === "enter" || key === "space") return { at: Math.min(at, count - 1), select: true };
  return null;
}

// The agent square: Claude, Codex and Gemini take their initial, a shell takes $.
export function letterOf(pane) {
  const key = String(pane?.program?.key ?? "").toLowerCase();
  if (LETTER[key]) return LETTER[key];
  if (pane?.program?.shell) return "$";
  const first = String(pane?.program?.name ?? "").match(/[\p{L}\p{N}]/u)?.[0];
  return first ? first.toUpperCase() : "$";
}

export default class Live extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "tabs";
    if (this.role === "pane") return;
    this.pressed = null;
    this.at = 0;
    this.keyboard = false;
    this.handle = cx.focus_handle();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Herdr's pane.go can move the keyboard off this bar without notifying the view.
    cx.timer.every(FOCUS_WATCH_MS, (cx) => this.watchFocus(cx));
  }

  focusKey() {
    return `${this.keyboard ? 1 : 0}|${this.handle?.is_focused?.() ? 1 : 0}`;
  }

  // Only the keyboard draws the tab's cursor: a click focuses the bar too.
  watchFocus(cx) {
    const key = this.focusKey();
    if (key === this.drawnFocus) return;
    this.drawnFocus = key;
    cx.notify();
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    return this.role === "pane" ? this.renderPane() : this.renderTabs();
  }

  renderTabs() {
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    this.at = Math.min(Math.max(this.at ?? 0, 0), Math.max(0, shown.length - 1));
    this.drawnFocus = this.focusKey();
    const focusedAt = (index) => this.keyboard && index === this.at && Boolean(this.handle?.is_focused?.());
    const stop = (_e, cx) => cx.stop_propagation();
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id && p.focused);
      const program = lead?.program ?? panes().find(p => p.tab === c.id)?.program;
      // An unnamed tab shows its agent's session title, else its space's name, not its position.
      const live = (lead?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const telling = live && !/^[~/]/.test(live) && !live.includes("@") && live !== program?.name;
      const name = !c.named ? (telling ? live : space?.name || c.name) : /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const marked = c.active || focusedAt(i);
      return h_flex().id(`tab-${c.id}`).h_full().px(14).gap(7).flex_none().relative().items_center()
        .bg(c.active ? C.termBg : focusedAt(i) ? C.panel3 : TRANSPARENT)
        .text_color(marked ? C.ink : C.ink2)
        .text_size(FS.base).font_family(FONT.body).font_weight(600)
        .role("tab").aria_selected(Boolean(c.active))
        .when(!c.active && !focusedAt(i), el => el.hover(s => s.bg(C.panel3).text_color(C.ink)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.keyboard = false; this.at = i; this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(c.active, el => el.child(div().absolute().top(0).left(10).right(10).h(2).bg(C.accent).rounded_b(2)))
        .when(focusedAt(i), el => el.child(div().absolute().top(8).bottom(8).left(0).w(3).rounded(2).bg(C.focusKb)))
        .child(div().size(16).flex_none().rounded(R.r1).bg(C.ink).flex().items_center().justify_center()
          .text_size(10).font_weight(700).font_family(FONT.body).text_color(C.bg).child(letterOf(lead)))
        .child(div().max_w(220).min_w(0).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(C.working).spin(900)))
        .when(c.status === "blocked", el => el.child(div().size(8).flex_none().rounded(4).bg(C.needs)))
        .when(c.status === "done", el => el.child(div().size(8).flex_none().rounded(4).bg(C.done)))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).size(16).flex_none().rounded(3).flex().items_center().justify_center()
          .text_color(C.ink3).hover(s => s.bg(C.veil3).text_color(C.ink))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
          .child(svg("mods/fm-live/close.svg").size(10))));
    };
    const root = layout();
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const windowButton = (b) => div().id(b.id).size(30).flex_none().rounded(R.r1).flex().items_center().justify_center()
      .text_color(C.ink2).hover((s) => s.bg(C.veil2).text_color(C.ink))
      .tooltip(b.label).on_mouse_down("left", stop)
      .on_click(() => run(b.command))
      .child(b.icon ? svg(`mods/fm-live/${b.icon}.svg`).size(b.size) : b.glyph);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return div().id(`panel-${id}`).size(32).flex_none().rounded(R.r1).flex().items_center().justify_center()
        .bg(on ? C.veil3 : TRANSPARENT).text_color(C.ink2)
        .hover(s => s.bg(on ? C.veil3 : C.veil2).text_color(C.ink))
        .tooltip(label).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(17));
    };
    return h_flex().size_full().min_w(0).pr(6).items_center()
      .rounded(R.r3).overflow_hidden()
      .track_focus(this.handle).tab_index(0)
      .on_mouse_down("left", () => { this.keyboard = false; })
      .on_key_down((event, cx) => {
        const next = tabsKey(event.key, this.at, shown.length);
        if (!next) return;
        this.keyboard = true;
        this.at = next.at;
        if (next.select) run("tab.select", { id: shown[this.at].id });
        cx.stop_propagation();
        cx.notify();
      })
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").min_w(0).h_full().items_center().overflow_x_scrollbar().children(shown.map(item)))
      .child(div().id("tab-new").size(30).flex_none().rounded(R.r1).flex().items_center().justify_center()
        .text_color(C.ink2).hover(s => s.bg(C.veil2).text_color(C.ink)).tooltip("New tab")
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))
        .child(svg("mods/fm-live/plus.svg").size(14)))
      .child(div().flex_1())
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/fm-live/files.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/fm-live/diff.svg")))
      .when(windowButtons().length > 0, el => el.children(windowButtons().map(windowButton)));
  }

  renderPane() {
    const p = panes().find((x) => x.pane === props()?.pane);
    if (!p) return div();
    const pane = p.pane;
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const st = p.status;
    const tool = (id, icon, command, args) => div().id(id).size(26).flex_none().rounded(R.r1).flex().items_center().justify_center()
      .text_color(C.ink2).hover(s => s.bg(C.panel3).text_color(C.ink))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/fm-live/${icon}.svg`).size(14));
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pl(12).pr(8)
      .gap(8)
      .items_center()
      .rounded_t(R.r3)
      .bg(C.panel2)
      .border_b(1)
      .border_color(C.line)
      .text_size(FS.base)
      .on_click(() => run("pane.focus", { pane }))
      .child(div().size(18).flex_none().rounded(R.r1).bg(C.ink).flex().items_center().justify_center()
        .text_size(10).font_weight(700).font_family(FONT.body).text_color(C.bg).child(letterOf(p)))
      .child(div().flex_none().truncate().max_w(260).font_family(FONT.body).font_weight(700).text_color(C.ink).child(name))
      .child(div().min_w(0).truncate().max_w(360).font_family(FONT.mono).text_size(FS.sm).text_color(C.ink3).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(C.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(R.pill).bg(C.needs + "26")
        .text_size(10).font_weight(700).text_color(C.needs).child("Touchline")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(C.done)))
      .when(Boolean(p.branch), el => el.child(h_flex().flex_none().gap(4).items_center().text_color(C.ink2)
        .child(svg("mods/fm-live/branch.svg").size(12))
        .child(div().font_family(FONT.mono).text_size(FS.sm).child(p.branch))))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(2)
        .child(tool(`ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(tool(`ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(tool(`ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(tool(`ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}
