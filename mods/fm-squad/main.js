// FM squad: the Squad table, the selected session's overview, the Inbox and the Dossier
// popup. The data, grouping, sort, keys and opening are forked from chiikawa-cards
// (scan.sh every 3 s); only the view layer is Football Manager's. props().role picks the
// view: default "squad", "overview", "inbox", "links". The squad role owns the keyboard,
// polls fm.cmd and publishes fm.squad for the other roles and fm-chrome.

import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, VirtualListScrollHandle } from "gpui-base";
import { exec, run, appHome, settings, readTextFile, writeTextFile, terminals, panes, agents, spaces, focused, nextCommand, props, shared, setShared, openOverlay, closeOverlay, setAgentOrder, layout } from "herdr";
import { C, FONT, FS, R, STATE, GROUP, NAT, KEY, SCREEN_STACK } from "./tokens.js";

export const SQUAD_KEY = KEY.squad;
export const NOTICE_KEY = KEY.notice;
export const NOTICE_ACT_KEY = KEY.noticeAct;
export const CMD_KEY = KEY.cmd;
export const SEL_KEY = KEY.sel;
export const NO_PAGE_FLASH = "No page can open yet — try again after the scan";
const POLL_MS = 3000;
const FOCUS_WATCH_MS = 100;
const STALL_MS = 10 * 60 * 1000;
const SNOOZE_MS = 10 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
export const MAX_DONE = 4;
export const INBOX_KINDS = ["all", "touchline", "reports"];
export const INBOX_EMPTY = {
  title: "Nothing on the touchline",
  hint: "Sessions that need your instructions and new match reports land here",
};
const SEEN_KEY = "fm27.seen";
const VIEWED_KEY = "fm27.viewed";
const REPORTS_KEY = "fm27.reports";
export const SCAN_KEY = "fm27.lastScan";
export const SCAN_TTL_MS = 30 * 60 * 1000;
export const UNDO_MS = 6000;
const NONE = "\u0000none";
export const LINKS_W = 300;

// `${appHome()}/fm27.json` gives the workspace URL bases and repo prefixes; absent keys
// simply drop their Dossier rows and repo detection.
export const DEFAULT_CONFIG = Object.freeze({ jiraBrowse: null, slackArchives: null, repos: [] });
export const CONFIG_PATH = "fm27.json";
let config = DEFAULT_CONFIG;

function baseUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  return text.endsWith("/") ? text : `${text}/`;
}

export function configFrom(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_CONFIG;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CONFIG;
  return {
    jiraBrowse: baseUrl(value.jiraBrowse),
    slackArchives: baseUrl(value.slackArchives),
    repos: Array.isArray(value.repos)
      ? value.repos.filter((repo) => typeof repo === "string" && repo.trim()).map((repo) => repo.trim())
      : [],
  };
}

export function setConfig(next) {
  config = configFrom(JSON.stringify(next ?? {}));
  return config;
}

export function getConfig() {
  return config;
}

async function readConfig() {
  try {
    return configFrom(await readTextFile(`${appHome()}/${CONFIG_PATH}`));
  } catch {
    return DEFAULT_CONFIG;
  }
}

// The bar band per state: the overview's head gradient.
const BAND = {
  needs: [C.needsBand, C.needsBand2],
  stall: [C.needsBand, C.needsBand2],
  working: [C.workingBand, C.workingBand2],
  done: [C.doneBand, C.doneBand2],
};

function clean(value) {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().split(/\s+/).join(" ");
  return collapsed || null;
}

function clip(value, limit) {
  const text = clean(value);
  if (!text) return null;
  return text.length > limit ? text.slice(0, limit) : text;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return null;
}

function fold(value) {
  const decomposed = String(value ?? "").normalize("NFD");
  return Array.from(decomposed).filter((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x300 || code > 0x36f;
  }).join("").toLowerCase();
}

function minutesOf(ms) {
  return Math.max(0, Math.floor(ms / 60000));
}

function clockText(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function normalizeLabel(value) {
  return String(value ?? "").toLowerCase().replace(/[-_]/g, "");
}

function trailingComponent(path) {
  const text = String(path ?? "").replace(/\/+$/, "");
  if (!text) return "";
  const parts = text.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function ackSession(key) {
  const index = key.lastIndexOf("+");
  return index > 0 ? key.slice(0, index) : key;
}

const KEY_RE = /(?:^|[^A-Za-z0-9])((?:cas|imio|ieis|web)-\d{1,5})(?![0-9])/i;

// Where a session runs, ticket key first: the ticket, then the rest, then the repo.
export function placeOf(cwd, maveyyo = null, cfg = config) {
  if (maveyyo) return { key: null, rest: null, repo: null, label: "ma’veyyo", slack: true };
  const parts = String(cwd ?? "").split("/").filter(Boolean);
  if (!parts.length) return { key: null, rest: null, repo: null, label: null, slack: false };
  let repo = null;
  let leaf = parts.at(-1);
  const workspaces = parts.indexOf("workspaces");
  const worktrees = parts.lastIndexOf("worktrees");
  if (workspaces >= 0 && parts[workspaces + 2]) {
    repo = parts[workspaces + 1];
    leaf = parts[workspaces + 2];
  } else if (worktrees >= 2 && parts[worktrees - 1] === ".claude" && parts[worktrees + 1]) {
    repo = parts[worktrees - 2];
    leaf = parts[worktrees + 1];
  } else {
    repo = cfg.repos.find((name) => leaf.startsWith(`${name}-`)) ?? null;
  }
  const match = leaf.match(KEY_RE);
  if (!match) return { key: null, rest: null, repo, label: leaf, slack: false };
  let rest = leaf.replace(match[1], " ");
  if (repo && rest.startsWith(`${repo}-`)) rest = rest.slice(repo.length + 1);
  rest = rest.split(/[\s-]+/).filter(Boolean).join("-")
    .replace(/(^|-)rd-\d{8}-\d{6}(?=-|$)/, "").replace(/(^|-)(?=[0-9a-f]*[a-f])[0-9a-f]{6}(?=-|$)/, "")
    .replace(/^-+|-+$/g, "") || null;
  return { key: match[1].toUpperCase(), rest, repo, label: [rest, repo].filter(Boolean).join(" · ") || match[1].toUpperCase(), slack: false };
}

// A Maveyyo session's folder is named <channel>-<thread seconds>_<fraction>.
export function slackThreadOf(cwd) {
  const match = String(cwd ?? "").split("/").pop().match(/^([A-Z0-9]+)-(\d+)_(\d+)$/);
  return match ? { channel: match[1], ts: `${match[2]}.${match[3]}` } : null;
}

// The deadhd plugin's Enable button sends one of these (register.tsx).
export const CHECKLIST_PROMPT = "deadhd 스킬로 이 세션의 체크리스트를 띄워 줘.";
export const CHECKLIST_QUEUED_PROMPT = "deadhd 스킬로 이 세션의 체크리스트를 띄워 줘. 이 요청은 앞 작업이 도는 동안 켜기 버튼으로 예약됐어. 그 작업이 끝나 남은 일이 없으면 켜지 말고 한 줄로만 알려 줘.";

// The Dossier's rows in order: game plan, ticket, pull requests, Slack thread, reports.
export function linksOf(item, cfg = config) {
  const links = [];
  if (item.jiraKey && cfg.jiraBrowse) {
    links.push({ kind: "jira", label: "Jira ticket", meta: item.jiraKey, url: `${cfg.jiraBrowse}${item.jiraKey}`, hot: "j" });
  }
  (item.prLinks ?? []).forEach((pr, i) => links.push({ kind: "pr", label: "Pull request", meta: pr.tag, url: pr.url, hot: i === 0 ? "p" : null }));
  if (item.slack && cfg.slackArchives) {
    links.push({ kind: "slack", label: "Slack thread", meta: item.lane ? `${item.lane} lane` : null,
      url: `${cfg.slackArchives}${item.slack.channel}/p${item.slack.ts.replace(".", "")}`, hot: "s" });
  }
  (item.pages ?? []).filter((page) => page.openable).forEach((page, i) => links.push({
    kind: "page", label: "Report", meta: page.label || null, url: page.url, hot: i === 0 ? "g" : null }));
  return links.filter((link) => link.url);
}

// The space and tab Ids a pane's tab lives in; the other screens match sessions on these.
function paneIds(pane) {
  if (!pane) return null;
  for (const space of spaces()) {
    if ((space.tabs ?? []).some((tab) => tab.id === pane.tab)) return { space: space.id, tab: pane.tab };
  }
  return null;
}

// The stack's active child is the truth; keys.json switches screens without writing fm.screen.
function activeScreen(node) {
  if (!node) return null;
  if (node.id === SCREEN_STACK) return node.active ?? null;
  for (const child of node.children ?? []) {
    const found = activeScreen(child);
    if (found) return found;
  }
  return null;
}

// { [space id]: name } for fm-chrome's ground switch and fm-club's space rows.
export function placesOf(spaceList) {
  const places = {};
  for (const space of spaceList ?? []) places[space.id] = space.name ?? null;
  return places;
}

// The links popup's height: 8 px padding, a 38 px head and its rule, 34 px rows, then a
// separator and Copy all. The stop row leads with its separator, then the game-plan row, which brings its own
// separator when links follow it.
export function linksMenuHeight(count, checklist = false, stop = false) {
  const base = 16 + 38 + 5;
  const rows = count > 0 ? count * 34 + 9 + 34 : 34;
  return base + (stop ? 34 + 9 : 0) + (checklist ? 34 + (count ? 9 : 0) : 0) + rows;
}

// A session name someone chose (`claude -n`, `/rename`), not one a launcher generated.
export function chosenTitle(name) {
  const text = clean(name);
  if (!text || /-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-\d{2}$/.test(text) || /^mv-\d+$/.test(text)) return null;
  return text;
}

export function emptyText(query) {
  return query ? "No matching sessions" : "All quiet for now";
}

// What a session is about, from scan.sh's identity.
export function topicOf(identity, key = null, objective = null) {
  if (!identity && !objective) return null;
  identity ??= {};
  const first = (value) => String(value).split(/(?<=[.?!])\s/)[0];
  let topic = objective ?? identity.handoff ?? (identity.maveyyo?.topic ? first(identity.maveyyo.topic) : null) ?? identity.paste ?? null;
  if (!topic && identity.firstPrompt) {
    topic = first(String(identity.firstPrompt).replace(/https?:\/\/\S+/g, " ").replace(/\[Image #\d+\]/g, " ").replace(/`/g, "")
      .replace(/(?:~|\/)[\w.-]*(?:\/[\w.-]+){2,}/g, " ").replace(/^\s*\/[\w-]+\s+/, "")
      .split(/\s+/).join(" ").trim().replace(/^(이거|지금|여기|내가|방금|아까)\s+/, ""));
  }
  if (!topic) return null;
  topic = topic.replace(/<@[A-Z0-9]+>/g, "")
    .replace(/\s*[—-]\s*rolling-delivery.*$/i, "").replace(/\s*\(rolling-delivery\)/i, "")
    .replace(/\s*(실행|본)?\s*핸드오프\s*$/, "").replace(/\s*\([^)]*(?:\d{4}-\d\d-\d\d|ts \d)[^)]*\)/g, "");
  topic = clean(topic);
  if (topic && key && topic.toUpperCase().startsWith(key)) topic = clean(topic.slice(key.length).replace(/^[\s—:-]+/, ""));
  return topic;
}

// A reply as one plain line: links, markdown marks and list bullets go.
export function cleanMessage(value) {
  if (typeof value !== "string") return null;
  return clean(value.replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*[^*]+\*\*\s*(?=-\s)/g, "")
    .replace(/\*\*/g, "").replace(/`/g, "")
    .replace(/(^|\s)-\s+/g, "$1"));
}

const BADGES = { "herdr-app": "herdr", herdr: "herdr", tmux: "tmux", orca: "orca" };

// The Herdr terminal a Pulse session runs in: by its foreground pid, else by its terminal
// id while that terminal still sits in the session's folder.
export function terminalOf(raw, live) {
  const byPid = live.find((terminal) => Number(terminal.foreground?.pid) === Number(raw.pid));
  if (byPid) return byPid;
  const id = raw.where?.terminalId;
  const terminal = id ? live.find((candidate) => candidate.address === id) : null;
  const folder = (path) => String(path ?? "").replace(/\/+$/, "");
  const here = [terminal?.foreground?.cwd, terminal?.cwd].filter(Boolean).map(folder);
  return terminal && raw.cwd && here.includes(folder(raw.cwd)) ? terminal : null;
}

// A conversation sent to the background: the bg record keeps its id and takes the frozen
// interactive record's terminal and checklist; the frozen record is dropped.
export function foldHandoffs(sessions) {
  const jobs = new Map(sessions.filter((raw) => raw.kind === "bg" && raw.jobId).map((raw) => [raw.jobId, raw]));
  const heirs = new Map();
  for (const old of sessions) {
    const bg = old.kind !== "bg" && old.parkedJobId ? jobs.get(old.parkedJobId) : null;
    if (bg && !heirs.has(bg)) heirs.set(bg, old);
  }
  if (!heirs.size) return sessions;
  const replaced = new Set(heirs.values());
  return sessions.filter((raw) => !replaced.has(raw)).map((raw) => {
    const old = heirs.get(raw);
    return old ? { ...raw, where: old.where ?? raw.where, deadhd: raw.deadhd ?? old.deadhd } : raw;
  });
}

export const HISTORY_MAX = 50;
const NAV_SETTLE_MS = 1000;

export function visitHistory(history, terminal) {
  if (!terminal || history.list[history.at] === terminal) return history;
  let list = [...history.list.slice(0, history.at + 1), terminal];
  if (list.length > HISTORY_MAX) list = list.slice(list.length - HISTORY_MAX);
  return { list, at: list.length - 1 };
}

// A dead terminal is skipped rather than stopping the walk.
export function stepHistory(history, delta, alive) {
  const { list, at } = history;
  for (let index = at + delta; index >= 0 && index < list.length; index += delta) {
    const terminal = list[index];
    if (alive.has(terminal) && terminal !== list[at]) return { history: { list, at: index }, target: terminal };
  }
  return { history, target: null };
}

// cmd +/-/0 change the terminals' text size in settings.json, never the zoom.
export const TERM_FONT = 14, TERM_FONT_MIN = 8, TERM_FONT_MAX = 32;
export function nextSettings(person, command, shown = TERM_FONT) {
  const next = { ...person };
  if (command === "font_reset") {
    delete next.font_size;
    next.zoom = 1;
    return next;
  }
  const d = command === "font_in" ? 1 : command === "font_out" ? -1 : 0;
  if (!d) return null;
  const now = Number(next.font_size ?? shown) || TERM_FONT;
  next.font_size = Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, Math.round(now) + d));
  return next;
}

function liveTerminals() {
  return terminals().filter((terminal) => terminal.state === "live" && !String(terminal.address ?? "").includes("/"));
}

// The football state of a model row.
export function stateOf(item) {
  if (item.group === "done") return "done";
  if (item.group === "working") return "working";
  return item.bucket === "stall" ? "stall" : "needs";
}

// The squad's shape: touchline-possession-fulltime.
export function shapeOf(counts) {
  return `${counts.attention}-${counts.working}-${counts.done}`;
}

export function groundOf(item) {
  const spot = item.spot ?? {};
  if (spot.slack) return spot.label ?? "ma’veyyo";
  const leaf = trailingComponent(item.raw?.cwd);
  if (leaf && !KEY_RE.test(leaf)) return clip(leaf, 48);
  if (spot.repo) return spot.rest ? `${spot.repo}-${spot.rest}` : spot.repo;
  if (leaf) return clip(leaf.replace(KEY_RE, "").replace(/^[-_]+|[-_]+$/g, ""), 48) ?? spot.label ?? null;
  return spot.label ?? clip(item.place, 40) ?? null;
}

export function ticketOf(item) {
  return item.spot?.key ?? item.jiraKey ?? (item.spot?.slack ? "Slack" : null);
}

export function agentKindOf(item) {
  const app = String(item.agent?.app ?? item.raw?.agent ?? "").toLowerCase();
  if (app.includes("codex")) return "codex";
  if (app.includes("gemini")) return "gemini";
  return "claude";
}

// A step as the squad contract states it: ok / cur / left.
export function planStep(step) {
  const source = step?.state;
  const state = source === "done" ? "ok" : source === "left" ? "left" : "cur";
  return { text: clean(step?.label) ?? "", state, note: clean(step?.sub ?? step?.ask) };
}

function pageReportKey(page) {
  return `${page?.sessionId ?? page?.terminalHandle ?? "?"}|${page?.pageId ?? page?.url ?? "?"}`;
}

// ---- small FM building blocks ----

function text(value, size = FS.base, color = C.ink) {
  return div().flex_none().text_size(size).font_family(FONT.body).text_color(color).child(String(value ?? ""));
}

function display(value, size = FS.lg, color = C.ink) {
  return div().flex_none().text_size(size).font_family(FONT.display).font_bold().text_color(color).child(String(value ?? ""));
}

function keycap(label) {
  return h_flex().h(18).min_w(18).px(4).rounded(R.r1).border(1).border_color(C.line2).bg(C.panel3)
    .items_center().justify_center()
    .child(div().text_size(FS.xs).font_family(FONT.body).font_semibold().text_color(C.ink2).child(String(label)));
}

function pill(label, { bg = C.panel3, color = C.ink, size = FS.sm } = {}) {
  return h_flex().h(22).flex_none().px(8).rounded(R.pill).bg(bg).gap(5).items_center()
    .child(div().text_size(size).font_family(FONT.body).font_semibold().text_color(color).child(String(label ?? "")));
}

function gradientFill(from, to, angle = 180) {
  const rect = PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
  return window.paint_path(rect, Background.linear_gradient(angle, from, to)).absolute().top(0).left(0).right(0).bottom(0);
}

function spinner(size = 11) {
  return svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(C.working).spin(900);
}

function pageGlyph(size = 12, color = C.ink2) {
  return svg("mods/workspace-chrome/file-text.svg").size(size).flex_none().text_color(color);
}

function statusSquare(state) {
  const base = h_flex().size(22).flex_none().rounded(R.r2).items_center().justify_center();
  if (state === "needs") return base.bg(C.needsFill).child(div().text_size(FS.sm).font_family(FONT.body).font_bold().text_color(C.paper).child("!"));
  if (state === "stall") return base.bg(C.stall).child(div().text_size(FS.sm).font_family(FONT.body).font_bold().text_color(C.bg).child("+"));
  if (state === "working") return base.bg(C.workingBand).child(spinner(10));
  return base.bg(C.panel3).child(div().text_size(FS.sm).font_family(FONT.body).font_bold().text_color(C.done).child("✓"));
}

function natFlag(agent) {
  const nat = NAT[agent] ?? NAT.claude;
  return h_flex().gap(4).items_center()
    .child(div().relative().w(18).h(12).flex_none().rounded(2).overflow_hidden().bg(nat.color)
      .child(div().absolute().left(0).right(0).bottom(0).h(4).bg(C.shade2)))
    .child(text(nat.code, FS.xs, C.ink2));
}


export default class FmSquad extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "squad";
    this.handle = cx.focus_handle();
    if (this.role === "links") {
      this.active = 0;
      this.error = null;
      this.stopError = null;
      // Focus can't change during render; the timer catches the popup once it is on screen.
      this.handle.focus();
      cx.timer.after(50, () => this.handle.focus());
      return;
    }
    if (this.role !== "squad") {
      this.filter = "all";
      this.picked = null;
      return;
    }
    this.scroll = VirtualListScrollHandle.new();
    this.lastFlash = shared("fm-squad.flash")?.token ?? null;
    this.lastNoticeAct = shared(NOTICE_ACT_KEY)?.token ?? null;
    this.lastCmd = shared(CMD_KEY)?.token ?? null;
    this.sessions = [];
    this.meta = { roots: 0, pages: [], unreadablePages: [] };
    this.err = null;
    this.notice = null;
    this.sel = null;
    this.selIndex = 0;
    this.handoff = false;
    this.doneCursor = null;
    this.query = "";
    this.expanded = new Set();
    this.stepTop = {};
    this.replyCursor = null;
    this.noticeAction = null;
    this.showAllDone = false;
    this.showKeys = false;
    this.groupFilter = null;
    this.snoozed = {};
    this.since = {}; // agent address -> { s, at }: when this view saw its status change
    this.seen = this.loadList(SEEN_KEY);
    this.viewed = this.loadList(VIEWED_KEY);
    this.readReports = this.loadList(REPORTS_KEY);
    this.scanning = false;
    this.published = null;
    this.publishedNotice = null;
    this.publishedSel = null;
    this.agentOrder = null;
    this.history = { list: [], at: -1 };
    this.navTarget = null;
    this.width = 0;
    this.inboxFilter = "all";
    cx.spawn(async (later) => {
      setConfig(await readConfig());
      later.notify();
    });
    if (this.restoreScan()) this.publish(this.viewData(), this.handle.is_focused());
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.handle.focus();
          cx.notify();
        } else if (command === "toggle") {
          // Bound to ctrl-alt-p in keys.json section "layout:fm27".
          if (this.handle.is_focused()) run("pane.go", { direction: "down" });
          else this.handle.focus();
          cx.notify();
        } else if (command === "font_in" || command === "font_out" || command === "font_reset") {
          await this.changeTermFont(command);
        } else if (command === "back" || command === "forward") {
          this.navigate(command === "back" ? -1 : 1);
        }
      }
    });
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    // Herdr's pane.go moves focus without notifying this view.
    cx.timer.every(FOCUS_WATCH_MS, (cx) => this.watchSquad(cx));
    this.poll(cx);
  }

  // settings.json is the person's file; a stale snapshot is retried like Herdr's Settings.
  async changeTermFont(command) {
    const file = `${appHome()}/settings.json`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await readTextFile(file);
        const person = raw ? JSON.parse(raw) : {};
        const next = nextSettings(person, command, Number(settings()?.font_size) || TERM_FONT);
        if (!next) return;
        await writeTextFile(file, JSON.stringify(next, null, 2) + "\n", raw);
        return;
      } catch {}
    }
  }

  loadList(key) {
    try {
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }

  saveList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {}
  }

  saveSeen() { this.saveList(SEEN_KEY, this.seen); }
  saveViewed() { this.saveList(VIEWED_KEY, this.viewed); }
  saveReports() { this.saveList(REPORTS_KEY, this.readReports); }

  // The last good scan, so the first frame has the table instead of waiting for scan.sh.
  saveScan(at = Date.now()) {
    try {
      localStorage.setItem(SCAN_KEY, JSON.stringify({ at, sessions: this.sessions, meta: this.meta }));
    } catch {}
  }

  restoreScan(now = Date.now()) {
    try {
      const raw = localStorage.getItem(SCAN_KEY);
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!Number.isFinite(cached?.at) || now - cached.at > SCAN_TTL_MS) return false;
      if (!Array.isArray(cached.sessions) || !cached.meta || typeof cached.meta !== "object") return false;
      this.sessions = cached.sessions;
      this.meta = cached.meta;
      return true;
    } catch {
      return false;
    }
  }

  poll(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      let error = null;
      let sessions = this.sessions;
      let meta = this.meta;
      try {
        const result = await exec("sh", [`${appHome()}/mods/fm-squad/scan.sh`]);
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout || "").trim() || `scan.sh exited ${result.code}`);
        }
        const parsed = this.parseScan(result.stdout ?? "");
        if (!parsed.meta) throw new Error("scan.sh returned no meta line");
        sessions = parsed.sessions;
        meta = parsed.meta;
      } catch (error_) {
        error = String(error_?.message ?? error_);
      }
      this.scanning = false;
      if (error) {
        this.err = String(error).replace(/\.$/, "");
      } else {
        this.err = meta.error ? String(meta.error).replace(/\.$/, "") : null;
        this.sessions = sessions;
        this.meta = meta;
        this.pruneSeen();
        if (!this.err) this.saveScan();
      }
      // The table can be the hidden child of the screens stack; chrome, inbox and notices
      // must still see the new state, and a hidden copy is never rendered.
      this.publish(this.viewData(), this.handle.is_focused());
      cx.notify();
    });
  }

  parseScan(output) {
    const sessions = [];
    let meta = null;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value?.t === "s") sessions.push(value);
      else if (value?.t === "meta") meta = value;
    }
    return { sessions, meta };
  }

  pruneSeen() {
    const live = new Set(this.sessions.map((session) => session.sessionId));
    for (const a of agents()) live.add(`agent:${a.address}`);
    const kept = this.seen.filter((key) => live.has(ackSession(key)));
    if (kept.length !== this.seen.length) {
      this.seen = kept;
      this.saveSeen();
    }
    const viewed = this.viewed.filter((key) => live.has(ackSession(key)));
    if (viewed.length !== this.viewed.length) {
      this.viewed = viewed;
      this.saveViewed();
    }
  }

  flash(cx, message, action = null, ms = 4000) {
    const token = {};
    this.notice = message;
    this.noticeAction = action;
    this.noticeToken = token;
    cx.notify();
    cx.timer.after(ms, (later) => {
      if (this.noticeToken === token) {
        this.notice = null;
        this.noticeAction = null;
        later.notify();
      }
    });
  }

  undoNotice() {
    if (!this.noticeAction) return;
    this.noticeAction.run();
    this.notice = null;
    this.noticeAction = null;
  }

  // Herdr agents Pulse doesn't list, as rows. Claude Code agents are left to Pulse's rows.
  agentItems(now, claimed) {
    const items = [];
    const list = agents();
    const present = new Set(list.map((a) => a.address));
    for (const address of Object.keys(this.since)) if (!present.has(address)) delete this.since[address];
    for (const a of list) {
      if (this.since[a.address]?.s !== a.status) this.since[a.address] = { s: a.status, at: now };
      if (claimed.has(a.address) || a.app === "claude-code") continue;
      const group = a.status === "blocked" ? "attention" : a.status === "working" ? "working" : "done";
      const since = this.since[a.address].at;
      const sessionId = `agent:${a.address}`;
      const ackKey = `${sessionId}+${a.seq}`;
      items.push({
        sessionId,
        pid: null,
        agent: a,
        raw: { status: a.status, cwd: null, name: this.agentName(a) },
        bucket: group === "attention" ? "wait" : group,
        group,
        title: clip(this.agentName(a), 60) ?? a.address,
        since,
        updatedAt: since,
        sortDate: since,
        place: clip(a.space_name, 40),
        spot: { key: null, rest: null, repo: null, label: clip(a.space_name, 40), slack: false },
        topic: null,
        round: null,
        lane: null,
        keyTag: null,
        jiraKey: null,
        prTag: null,
        extraPRs: [],
        prLinks: [],
        slack: null,
        hasChecklist: false,
        counts: null,
        total: null,
        progress: null,
        stepStates: null,
        steps: [],
        progressStale: false,
        blocked: group === "attention",
        eta: null,
        etaMinutes: null,
        nowLabel: null,
        nowLine: a.program?.name ? `${a.program.name} is working` : null,
        answer: "Waiting for your reply",
        prompt: null,
        replyTail: null,
        lastSentence: null,
        background: null,
        pages: [],
        where: { kind: "herdr", terminalId: a.address },
        terminal: a.address,
        ackKey,
        viewed: this.viewed.includes(ackKey),
        badge: "herdr",
        space: a.space ?? null,
        tab: a.tab ?? null,
      });
    }
    return items;
  }

  // The tower's session name: the terminal title without leading symbols, else the tab, else the program.
  agentName(a) {
    const live = String(a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (live && !/^[~/]/.test(live) && !live.includes("@") && live !== a.program?.name) return live;
    return a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : a.program?.name ?? a.address;
  }

  buildModel(now) {
    const seen = new Set(this.seen);
    const live = liveTerminals();
    const claimed = new Set();
    const items = [];
    for (const raw of foldHandoffs(this.sessions)) {
      const deadhd = raw.deadhd ?? null;
      const hasChecklist = Boolean(deadhd && !deadhd.off && deadhd.counts && (deadhd.total ?? 0) > 0);
      const counts = hasChecklist ? deadhd.counts : null;
      const background = raw.background ?? { shells: 0, agents: 0, monitors: 0, total: 0 };
      const terminal = terminalOf(raw, live);
      if (terminal) claimed.add(terminal.address);

      let bucket;
      if (raw.status === "waiting") bucket = "wait";
      else if (raw.status === "busy") {
        const hasBackground = (background.total ?? 0) > 0;
        const last = raw.lastMeaningfulAt;
        bucket = !hasBackground && last && now - last > STALL_MS ? "stall" : "working";
      } else if (raw.status === "shell") {
        bucket = (counts?.blocked ?? 0) > 0 ? "wait" : "working";
      } else if (raw.status === "idle") {
        bucket = "done";
      } else {
        bucket = "working";
      }
      // A native agent's approval prompt is never on disk; its Herdr status is the signal.
      if (raw.agent && raw.agent !== "claude" && terminal) {
        const spoke = agents().find((entry) => entry.address === terminal.address);
        if (spoke?.status === "blocked") bucket = "wait";
      }

      let group = bucket === "wait" || bucket === "stall" ? "attention" : bucket === "done" ? "done" : "working";
      if (group === "attention" && bucket === "stall" && (this.snoozed[raw.sessionId] ?? 0) > now) {
        group = "working";
      }

      const since = raw.statusUpdatedAt ?? raw.startedAt ?? null;
      const updatedAt = Math.max(raw.statusUpdatedAt ?? 0, raw.lastMeaningfulAt ?? 0) || null;
      const title = clip(firstNonEmpty(
        hasChecklist ? deadhd.title : null,
        raw.customTitle,
        raw.agentName,
        raw.name,
        raw.lastPrompt ? clip(raw.lastPrompt, 60) : null,
      ), 60) ?? "Untitled session";

      const location = clip(raw.location, 40);
      const place = location && normalizeLabel(location) !== normalizeLabel(title) ? location : null;
      const keyTag = deadhd?.key && deadhd.key.toLowerCase() !== title.trim().toLowerCase() ? deadhd.key : null;
      const identity = raw.identity ?? null;
      const spot = placeOf(raw.cwd, identity?.maveyyo ?? null);
      if (!spot.key && !spot.slack && deadhd?.key) spot.key = String(deadhd.key).toUpperCase();
      const topic = clip(firstNonEmpty(chosenTitle(raw.customTitle), hasChecklist ? deadhd.title : null, topicOf(identity, spot.key, spot.key ? this.meta?.objectives?.[spot.key] : null)), 120);
      const round = spot.key && Number.isFinite(identity?.round) ? identity.round : null;
      const lane = clean(identity?.maveyyo?.lane);

      const prs = [];
      if (hasChecklist && deadhd.pr?.href) {
        prs.push({ url: deadhd.pr.href, label: deadhd.pr.text ?? null, number: deadhd.pr.number ?? 0 });
      }
      if (raw.pr?.url && !prs.some((pr) => pr.url === raw.pr.url)) {
        prs.push({ url: raw.pr.url, label: raw.pr.label ?? null, number: raw.pr.number ?? 0 });
      }
      const prRepo = (url) => String(url ?? "").split("/")[4] ?? null;
      const prTag = prs[0] ? (prs[0].label ?? (prs[0].number
        ? `${spot.repo && prRepo(prs[0].url) && prRepo(prs[0].url) !== spot.repo ? prRepo(prs[0].url) : ""}#${prs[0].number}`
        : null)) : null;
      const extraPRs = prs.slice(1).map((pr) => pr.label ?? (pr.number ? `#${pr.number}` : pr.url)).filter(Boolean);

      const progress = hasChecklist && (deadhd.total ?? 0) > 0
        ? { done: Math.max(0, counts.done), total: deadhd.total }
        : null;
      const steps = hasChecklist && Array.isArray(deadhd.items) ? deadhd.items : [];
      let etaMinutes = null;
      if (hasChecklist && Number.isFinite(deadhd.eta)) {
        const left = Math.ceil((deadhd.eta - now) / 60000);
        if (left > 0) etaMinutes = left;
      }
      const eta = etaMinutes ? `~${etaMinutes}m left` : null;
      const nowLabel = clean(hasChecklist ? deadhd.nowLabel : null);
      const currentAction = clean(raw.currentAction);
      const lastSentence = clean(raw.lastSentence);
      let nowLine = null;
      if (nowLabel) nowLine = `▶ ${nowLabel}`;
      else if (currentAction) nowLine = currentAction;
      else if (lastSentence) nowLine = lastSentence;

      let answer;
      if (bucket === "stall") {
        const quiet = Math.max(1, minutesOf(now - (raw.lastMeaningfulAt ?? since ?? now)));
        answer = `No new activity for ${quiet} minute${quiet === 1 ? "" : "s"}. Check whether it is stuck`;
      } else if (hasChecklist && (counts?.blocked ?? 0) > 0 && deadhd.blockedAsk) {
        answer = deadhd.blockedAsk;
      } else {
        answer = clean(raw.lastAnswer)
          ?? (raw.waitingFor === "permission prompt" ? "Waiting for permission approval" : "Waiting for your reply");
      }

      const pages = Array.isArray(raw.pages) ? raw.pages : [];
      const ackKey = `${raw.sessionId}+${since != null ? Math.floor(since / 1000) : "none"}`;
      const sortDate = since ?? updatedAt;

      if (group === "done" && seen.has(ackKey)) continue;

      const pane = terminal ? panes().find((candidate) => candidate.terminal === terminal.address) : null;
      const ids = paneIds(pane);

      items.push({
        sessionId: raw.sessionId,
        pid: raw.pid,
        raw,
        bucket,
        group,
        title,
        since,
        updatedAt,
        sortDate,
        place,
        spot,
        topic,
        round,
        lane,
        keyTag,
        jiraKey: deadhd?.key ?? spot.key ?? null,
        prTag,
        extraPRs,
        prLinks: prs.map((pr, i) => ({ url: pr.url, tag: (i === 0 ? prTag : extraPRs[i - 1]) ?? pr.url })),
        slack: spot.slack ? slackThreadOf(raw.cwd) : null,
        hasChecklist,
        counts,
        total: deadhd?.total ?? null,
        progress,
        stepStates: deadhd?.states ?? null,
        steps,
        progressStale: Boolean(deadhd?.dataAt && now - deadhd.dataAt > STALE_MS),
        blocked: (counts?.blocked ?? 0) > 0,
        eta,
        etaMinutes,
        nowLabel,
        nowLine,
        answer,
        replyTail: clean(raw.lastAnswer),
        lastSentence,
        background,
        pages,
        where: raw.where ?? {},
        ackKey,
        viewed: this.viewed.includes(ackKey),
        badge: BADGES[raw.where?.kind] ?? null,
        terminal: terminal?.address ?? null,
        space: ids?.space ?? null,
        tab: ids?.tab ?? null,
        backgrounded: raw.kind === "bg" && !this.attachedFocus(raw.where ?? {}),
      });
    }

    for (const item of this.agentItems(now, claimed)) {
      if (item.group === "done" && seen.has(item.ackKey)) continue;
      items.push(item);
    }

    const sortAsc = (a, b) => {
      if (a.sortDate == null && b.sortDate == null) return a.sessionId < b.sessionId ? -1 : 1;
      if (a.sortDate == null) return 1;
      if (b.sortDate == null) return -1;
      if (a.sortDate !== b.sortDate) return a.sortDate - b.sortDate;
      return a.sessionId < b.sessionId ? -1 : 1;
    };
    const sortDesc = (a, b) => {
      if (a.sortDate == null && b.sortDate == null) return a.sessionId < b.sessionId ? -1 : 1;
      if (a.sortDate == null) return 1;
      if (b.sortDate == null) return -1;
      if (a.sortDate !== b.sortDate) return b.sortDate - a.sortDate;
      return a.sessionId < b.sessionId ? -1 : 1;
    };

    // Replies first, then stalls, so Space always starts at the leftmost touchline row.
    const stalled = (item) => (item.bucket === "stall" ? 1 : 0);
    const attention = items.filter((item) => item.group === "attention").sort((a, b) => stalled(a) - stalled(b) || sortAsc(a, b));
    const working = items.filter((item) => item.group === "working").sort(sortAsc);
    const done = items.filter((item) => item.group === "done").sort(sortDesc);
    return {
      attention,
      working,
      done,
      counts: { attention: attention.length, working: working.length, done: done.length },
    };
  }

  matches(item, tokens) {
    if (!tokens.length) return true;
    const fields = [
      item.title,
      item.topic,
      item.place,
      item.spot?.label,
      trailingComponent(item.raw.cwd),
      item.raw.name,
      item.keyTag,
      item.jiraKey,
      item.prTag,
      ...item.extraPRs,
    ].filter(Boolean).map(fold);
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  }

  viewData(now = Date.now()) {
    const model = this.buildModel(now);
    this.places = placesOf(spaces());
    const tokens = fold(this.query).split(/\s+/).filter(Boolean);
    const filter = (list) => (tokens.length ? list.filter((item) => this.matches(item, tokens)) : list);
    const attention = filter(model.attention);
    const working = filter(model.working);
    const doneAll = filter(model.done);
    const doneVisible = this.showAllDone || tokens.length ? doneAll : doneAll.slice(0, MAX_DONE);
    const hiddenDone = doneAll.length - doneVisible.length;
    const groups = [
      { id: "attention", title: GROUP.attention.title, hint: GROUP.attention.hint, color: GROUP.attention.color, items: attention, count: attention.length },
      { id: "working", title: GROUP.working.title, hint: GROUP.working.hint, color: GROUP.working.color, items: working, count: working.length },
      { id: "done", title: GROUP.done.title, hint: GROUP.done.hint, color: GROUP.done.color, items: doneVisible, count: doneAll.length },
    ];
    const allGroups = [
      { id: "attention", items: model.attention },
      { id: "working", items: model.working },
      { id: "done", items: model.done },
    ];
    // fm-chrome's sub tabs narrow the table to one group; the published counts stay whole-squad.
    const shown = this.groupFilter ? groups.filter((group) => group.id === this.groupFilter) : groups;
    const hiddenShown = shown.some((group) => group.id === "done") ? hiddenDone : 0;
    return { model, groups: shown, allGroups, hiddenDone: hiddenShown, now, counts: model.counts, shape: shapeOf(model.counts) };
  }

  stepWindow(steps) {
    const states = steps.map((step) => step.state);
    const total = states.length;
    const first = (state) => { const at = states.indexOf(state); return at >= 0 ? at : null; };
    const focus = first("now") ?? first("side") ?? first("blocked") ?? first("left") ?? total - 1;
    return { total, focus };
  }

  stepMaxTop(item) {
    return Math.max(0, item.steps.length - STEP_ROWS());
  }

  openSteps(item) {
    const { focus } = this.stepWindow(item.steps);
    this.stepTop[item.sessionId] = Math.min(Math.max(focus - 1, 0), this.stepMaxTop(item));
    this.expanded.add(item.sessionId);
  }

  scrollSteps(item, delta) {
    const top = this.stepTop[item.sessionId] ?? 0;
    this.stepTop[item.sessionId] = Math.max(0, Math.min(this.stepMaxTop(item), top + delta));
  }

  // A checklist can lose steps while the window is open, so the top is clamped here too.
  visibleSteps(item) {
    const top = Math.min(this.stepTop[item.sessionId] ?? 0, this.stepMaxTop(item));
    return item.steps.slice(top, top + STEP_ROWS());
  }

  stepCounter(item) {
    const shown = this.visibleSteps(item).length;
    if (shown >= item.steps.length) return null;
    const top = Math.min(this.stepTop[item.sessionId] ?? 0, this.stepMaxTop(item));
    return `${top + 1}–${top + shown} / ${item.steps.length}`;
  }

  focusKey() {
    return `${Boolean(this.handle?.is_focused?.())}|${focused()?.terminal ?? ""}`;
  }

  watchSquad(cx) {
    this.trackVisit();
    if (this.focusKey() !== this.drawnFocus) cx.notify();
    const flash = shared("fm-squad.flash");
    if (flash?.token && flash.token !== this.lastFlash) {
      this.lastFlash = flash.token;
      this.flash(cx, flash.message);
    }
    const noticeAct = shared(NOTICE_ACT_KEY);
    if (noticeAct?.token && noticeAct.token !== this.lastNoticeAct) {
      this.lastNoticeAct = noticeAct.token;
      if (noticeAct.act === "retry") {
        this.err = null;
        this.poll(cx);
      } else if (noticeAct.act === "undo") {
        this.undoNotice();
      }
      cx.notify();
    }
    const command = shared(CMD_KEY);
    if (command?.token && command.token !== this.lastCmd) {
      this.lastCmd = command.token;
      this.runCommand(command, cx);
      cx.notify();
    }
    // A key command can change what chrome and the other screens show while this copy is hidden.
    this.publish(this.viewData(), this.handle.is_focused());
  }

  // Commands from fm-chrome, the overview and the inbox: one-shot, by token.
  runCommand(command, cx) {
    const data = this.viewData();
    const items = data.allGroups.flatMap((group) => group.items);
    const find = (key) => items.find((item) => item.sessionId === key) ?? null;
    const { name, args = {} } = command ?? {};
    if (name === "select") {
      const item = find(args.key);
      if (item) {
        this.sel = item.sessionId;
        this.reveal(item.sessionId, data);
      }
    } else if (name === "go") {
      const item = find(args.key);
      if (item) {
        this.sel = item.sessionId;
        this.goTo(item, cx);
      }
    } else if (name === "links") {
      const item = find(args.key);
      if (item) this.openLinks(`row-${item.sessionId}`, cx);
    } else if (name === "report") {
      const item = find(args.key);
      if (item) {
        const page = args.id
          ? item.pages.find((candidate, index) => (candidate.pageId ?? `p${index}`) === args.id) ?? item.pages[0]
          : item.pages[0];
        if (page) this.openPage(page, cx);
      }
    } else if (name === "release") {
      const item = find(args.key);
      if (item) this.acknowledge(item, cx);
    } else if (name === "undo") {
      this.undoNotice();
    } else if (name === "continue") {
      this.jump("reply", data, cx);
    } else if (name === "next-done") {
      this.jump("done", data, cx);
    } else if (name === "next-report") {
      this.openOldestPage(cx);
    } else if (name === "back") {
      this.navigate(-1);
    } else if (name === "forward") {
      this.navigate(1);
    } else if (name === "toggle") {
      this.toggleKeyboard();
    } else if (name === "font_in" || name === "font_out" || name === "font_reset") {
      this.changeTermFont(name);
    } else if (name === "search") {
      this.query = String(args.query ?? "");
    } else if (name === "filter") {
      this.groupFilter = ["attention", "working", "done"].includes(args.group) ? args.group : null;
    } else if (name === "inbox-filter") {
      this.inboxFilter = INBOX_KINDS.includes(args.kind) ? args.kind : "all";
      this.patchPublishedFilter();
    }
  }

  // ctrl-alt-p reaches the shown chrome only, so it arrives as fm.cmd. From a terminal it gives
  // the table the keyboard; on the table it hands it back. Another screen switches to Squad
  // first, since this copy is the one that holds it.
  toggleKeyboard() {
    if (this.role !== "squad") return;
    if (this.handle.is_focused()) {
      run("pane.go", { direction: "down" });
      return;
    }
    const screen = activeScreen(layout()) ?? shared(KEY.screen);
    if (screen && screen !== "squad") {
      setShared(KEY.screen, "squad");
      run("layout.select", { stack: SCREEN_STACK, child: "squad" });
    }
    this.handle.focus();
  }

  // The squad role can be the hidden child of the screens stack when the Inbox is open; the chrome
  // still needs the new kind in fm.squad now, not on this view's next draw.
  patchPublishedFilter() {
    if (!this.published) return;
    let value;
    try { value = JSON.parse(this.published); } catch { return; }
    if (!value || value.inboxFilter === this.inboxFilter) return;
    value.inboxFilter = this.inboxFilter;
    this.published = JSON.stringify(value);
    setShared(SQUAD_KEY, value);
  }

  // After a back/forward, the terminal being left can still show as focused for a few watches.
  trackVisit(now = Date.now()) {
    const terminal = focused()?.terminal ?? null;
    if (!terminal) return;
    if (this.navTarget) {
      if (terminal === this.navTarget) {
        this.navTarget = null;
        return;
      }
      if (now < this.navUntil) return;
      this.navTarget = null;
    }
    this.history = visitHistory(this.history, terminal);
  }

  navigate(delta) {
    const alive = new Set(liveTerminals().map((terminal) => terminal.address));
    const { history, target } = stepHistory(this.history, delta, alive);
    if (!target) return;
    this.history = history;
    this.navTarget = target;
    this.navUntil = Date.now() + NAV_SETTLE_MS;
    run("pane.focus", { terminal: target });
  }

  // While the squad doesn't have the keyboard, the selection follows the focused pane.
  followFocus(data) {
    const terminal = focused()?.terminal ?? null;
    if (terminal === this.followed) return;
    if (!terminal || this.handle?.is_focused()) {
      this.followed = null;
      return;
    }
    const item = data.groups.flatMap((group) => group.items).find((row) => row.terminal === terminal);
    if (!item) return;
    this.followed = terminal;
    this.markViewed(item);
    this.sel = item.sessionId;
    this.reveal(item.sessionId, data);
  }

  selectedItem(data) {
    const rows = data.groups.flatMap((group) => group.items);
    if (this.sel === NONE) return null;
    const kept = rows.find((item) => item.sessionId === this.sel);
    if (kept || !(this.sel == null || this.handoff || this.query)) return kept ?? null;
    return rows[Math.min(this.selIndex, rows.length - 1)] ?? null;
  }

  // The table's rows, headers included, in draw order.
  tableRows(data) {
    const rows = [];
    let number = 0;
    let zebra = 0;
    for (const group of data.groups) {
      rows.push({ kind: "group", group, key: `group-${group.id}` });
      for (const item of group.items) {
        number += 1;
        rows.push({ kind: "row", item, group, number, alt: zebra % 2 === 1, key: `row-${item.sessionId}` });
        zebra += 1;
      }
      if (group.id === "done" && data.hiddenDone > 0) {
        rows.push({ kind: "more", group, count: data.hiddenDone, key: "more-done" });
      }
    }
    return rows;
  }

  reveal(sessionId, data) {
    const rows = this.tableRows(data);
    const index = rows.findIndex((entry) => entry.kind === "row" && entry.item.sessionId === sessionId);
    if (index < 0) return;
    this.scroll?.scroll_to_item?.(index);
  }

  markViewed(item) {
    if (!item || item.group !== "done") return false;
    if (this.viewed.includes(item.ackKey)) return false;
    this.viewed = [...this.viewed, item.ackKey];
    this.saveViewed();
    return true;
  }

  markSeen(item, cx) {
    if (!item || item.group !== "done") return false;
    if (this.seen.includes(item.ackKey)) return false;
    this.seen = [...this.seen, item.ackKey];
    this.saveSeen();
    const key = item.ackKey;
    const ticket = ticketOf(item) ?? item.title;
    if (cx) this.flash(cx, `Subbed off ${ticket}`, { label: "Undo", run: () => {
      this.seen = this.seen.filter((candidate) => candidate !== key);
      this.saveSeen();
    } }, UNDO_MS);
    return true;
  }

  acknowledge(item, cx) {
    if (!item) return;
    let left = false;
    if (item.group === "done") left = this.markSeen(item, cx);
    else if (item.group === "attention" && item.bucket === "stall") left = this.snooze(item);
    if (left && item.sessionId === this.sel) this.handoff = true;
  }

  // Space: the touchline call that has waited longest, cycling; stalls are skipped.
  // Shift+Space: every full-time row from the oldest leftward, cycling.
  jump(kind, data, cx) {
    let target = null;
    if (kind === "reply") {
      const candidates = data.model.attention.filter((item) => item.bucket !== "stall");
      if (candidates.length) {
        const at = candidates.findIndex((item) => item.sessionId === this.replyCursor);
        target = at < 0 ? candidates[0] : candidates[(at + 1) % candidates.length];
        this.replyCursor = target.sessionId;
      }
    } else {
      const candidates = [...data.model.done].reverse();
      if (candidates.length) {
        const at = candidates.findIndex((item) => item.sessionId === this.doneCursor);
        target = at < 0 ? candidates[0] : candidates[(at + 1) % candidates.length];
        this.doneCursor = target.sessionId;
      }
    }
    if (!target) {
      this.flash(cx, kind === "reply" ? "No touchline call — check back later" : "No session at full time — finish a turn first");
      return;
    }
    this.goTo(target, cx);
    if (kind === "done") this.showAllDone = true;
    this.sel = target.sessionId;
    this.reveal(target.sessionId, data);
  }

  snooze(item) {
    if (!item || item.bucket !== "stall") return false;
    this.snoozed[item.sessionId] = Date.now() + SNOOZE_MS;
    return true;
  }

  // The pane already running `claude attach` for a background session.
  attachedFocus(where) {
    if (where.paneId && panes().some((candidate) => candidate.pane === where.paneId)) return { pane: where.paneId };
    if (!where.terminalId || !liveTerminals().some((terminal) => terminal.address === where.terminalId)) return null;
    const pane = panes().find((candidate) => candidate.terminal === where.terminalId);
    return pane ? { pane: pane.pane } : { terminal: where.terminalId };
  }

  focusOf(item) {
    if (!item) return null;
    if (item.agent?.pane) return { pane: item.agent.pane };
    const where = item.where ?? {};
    if (where.kind === "claude-bg") return this.attachedFocus(where);
    const terminal = terminalOf(item.raw ?? item, liveTerminals());
    if (!terminal) return null;
    const pane = panes().find((candidate) => candidate.terminal === terminal.address);
    return pane ? { pane: pane.pane } : { terminal: terminal.address };
  }

  goTo(item, cx) {
    if (!item) return;
    if (item.group === "done") this.markViewed(item);
    if (item.agent) {
      run("pane.focus", { pane: item.agent.pane });
      return;
    }
    const terminal = terminalOf(item.raw ?? item, liveTerminals());
    if (terminal) {
      const pane = panes().find((candidate) => candidate.terminal === terminal.address);
      run("pane.focus", pane ? { pane: pane.pane } : { terminal: terminal.address });
      return;
    }
    const where = item.where ?? {};
    if (where.kind === "claude-bg") {
      const focus = this.attachedFocus(where);
      if (focus) {
        run("pane.focus", focus);
        return;
      }
      // The scan that reports the attach pane runs seconds later; a second click meanwhile must not open another.
      const opened = this.attachOpened?.[where.attachId];
      if (opened && Date.now() - opened < 15000) return;
      this.attachOpened = { ...this.attachOpened, [where.attachId]: Date.now() };
      run("pane.split", { direction: "right", argv: ["claude", "attach", where.attachId] });
      return;
    }
    if (where.kind === "tmux" && where.paneId) {
      const base = where.socket ? ["-S", where.socket] : [];
      const calls = [
        ["switch-client", "-t", where.paneId],
        ["select-window", "-t", where.paneId],
        ["select-pane", "-t", where.paneId],
      ];
      cx.spawn(async () => {
        for (const call of calls) {
          try {
            await exec("tmux", [...base, ...call]);
          } catch {}
        }
      });
      return;
    }
    if (where.handle) {
      cx.spawn(async (later) => {
        try {
          const result = await exec("/Applications/Orca.app/Contents/Resources/bin/orca",
            ["terminal", "switch", "--terminal", where.handle, "--json"]);
          if (result.code !== 0) this.flash(later, "Not in Herdr, tmux or Orca — open the session's terminal first");
          else await exec("open", ["-a", "Orca"]);
        } catch {
          this.flash(later, "Not in Herdr, tmux or Orca — open the session's terminal first");
        }
      });
      return;
    }
    this.flash(cx, "Not in Herdr, tmux or Orca — open the session's terminal first");
  }

  pageGroup(item) {
    return item?.pages?.[0] ?? null;
  }

  progressTarget(item) {
    const path = item.raw.deadhd?.pagePath;
    if (path) return { url: path, openable: true, files: [] };
    return this.pageGroup(item);
  }

  dropPage(page) {
    const same = (candidate) => candidate
      && candidate.pageId === page.pageId
      && candidate.worktree === page.worktree
      && candidate.url === page.url;
    if (this.meta?.pages) this.meta.pages = this.meta.pages.filter((candidate) => !same(candidate));
    for (const session of this.sessions) {
      if (Array.isArray(session.pages)) session.pages = session.pages.filter((candidate) => !same(candidate));
    }
  }

  markReportRead(page) {
    if (!page?.pageId) return;
    const key = pageReportKey(page);
    if (this.readReports.includes(key)) return;
    this.readReports = [...this.readReports, key];
    this.saveReports();
  }

  openPage(page, cx) {
    if (!page) {
      this.flash(cx, "No page to open — try again after the scan");
      return;
    }
    if (!page.openable) {
      this.flash(cx, "Couldn't open this page — check the file still exists");
      return;
    }
    cx.spawn(async (later) => {
      if (!(await this.openPageFiles(page))) {
        this.flash(later, "Couldn't open this page — check the file still exists");
        return;
      }
      this.markReportRead(page);
      this.dropPage(page);
      later.notify();
      this.poll(later);
    });
  }

  // Opens a page URL, then deletes the alert files behind it. Resolves true when it opened.
  async openPageFiles(page) {
    let opened = false;
    try {
      const result = await exec("open", [page.url]);
      opened = result.code === 0;
    } catch {}
    if (!opened) return false;
    try {
      await exec("rm", ["-f", ...(page.files ?? [])]);
    } catch {}
    return true;
  }

  openOldestPage(cx) {
    const pages = this.meta?.pages ?? [];
    if (!pages.length) {
      this.flash(cx, "No page to open — try again after the scan");
      return;
    }
    this.openPage(pages[0], cx);
  }

  key(event, cx) {
    const modifiers = event.modifiers ?? {};
    const alt = Boolean(modifiers.alt);
    const shift = Boolean(modifiers.shift);
    const command = Boolean(modifiers.platform);
    const control = Boolean(modifiers.control);
    const key = event.key;
    const data = this.viewData();
    const items = data.groups.flatMap((group) => group.items);
    const selected = this.selectedItem(data);
    if (selected && this.sel !== selected.sessionId) this.sel = selected.sessionId;
    const index = items.findIndex((item) => item.sessionId === selected?.sessionId);

    const choose = (next) => {
      if (!items.length) return;
      const target = items[Math.max(0, Math.min(items.length - 1, next))];
      this.sel = target.sessionId;
      this.reveal(target.sessionId, data);
    };

    const plain = !command && !control && !alt;
    const searching = Boolean(this.query);
    let handled = true;
    if (key === "p" && control && alt && !command) {
      // ctrl-alt-p while the squad has the keyboard: the keys.json binding alone does not hand it back.
      run("pane.go", { direction: "down" });
    } else if (key === "escape") {
      if (searching) this.query = "";
      else if (this.groupFilter) this.groupFilter = null;
      else if (this.sel !== NONE && selected) this.sel = NONE;
      else {
        run("pane.go", { direction: "down" });
        handled = false;
      }
    } else if (key === "backspace" && plain) {
      if (searching) this.query = this.query.slice(0, -1);
      else if (!event.is_held) this.acknowledge(selected, cx);
    } else if (key === "backspace" && searching && command && !control && !alt) {
      this.query = "";
    } else if (key === "backspace" && searching && alt && !command && !control) {
      this.query = this.query.replace(/\S*\s*$/, "");
    } else if (key === "left" && alt) choose(0);
    else if (key === "right" && alt) choose(items.length - 1);
    else if (key === "left") choose(index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length);
    else if (key === "right") {
      if (index === items.length - 1 && data.hiddenDone > 0) {
        this.showAllDone = true;
        const next = this.viewData();
        const target = next.groups.flatMap((group) => group.items)[items.length];
        if (target) {
          this.sel = target.sessionId;
          this.reveal(target.sessionId, next);
        }
      } else choose(index < 0 ? 0 : (index + 1) % items.length);
    } else if (key === "down") {
      if (selected?.steps.length) {
        if (this.expanded.has(selected.sessionId)) this.scrollSteps(selected, 1);
        else this.openSteps(selected);
      } else handled = false;
    } else if (key === "up") {
      if (selected?.steps.length && this.expanded.has(selected.sessionId)) {
        if ((this.stepTop[selected.sessionId] ?? 0) > 0) this.scrollSteps(selected, -1);
        else this.expanded.delete(selected.sessionId);
      } else handled = false;
    } else if (key === "enter") {
      if (command && !shift && !control && !alt) {
        // macOS has no context-menu key, so ⌘↩ opens the Dossier a right-click opens.
        if (selected) this.openLinks(`row-${selected.sessionId}`, cx);
      } else if (shift) {
        const page = selected && selected.group !== "done" ? this.progressTarget(selected) : this.pageGroup(selected);
        if (page) this.openPage(page, cx);
        else this.flash(cx, "This row has no match report — pick a session that has one");
      } else this.goTo(selected, cx);
    } else if (key === "space" && plain && !searching) {
      this.jump(shift ? "done" : "reply", data, cx);
    } else if ((key === "?" || (key === "/" && shift)) && !searching) {
      this.showKeys = !this.showKeys;
    } else if (key === "tab" && plain && !shift) {
      if (searching) handled = false;
      else this.openOldestPage(cx);
    } else if (key === "z" && command && !shift && !control && !alt) {
      if (this.noticeAction) this.undoNotice();
      else handled = false;
    } else if (event.key_char && event.key_char.length === 1 && plain) {
      if (searching || event.key_char.trim()) this.query += event.key_char;
      else handled = false;
    } else {
      handled = false;
    }

    if (handled) {
      cx.stop_propagation();
      cx.notify();
    }
  }

  // A right-click or ⌘↩ on a row: the Dossier at the pointer (or where Herdr puts a popup).
  openLinks(key, cx, at) {
    const item = this.viewData().allGroups.flatMap((group) => group.items).find((entry) => `row-${entry.sessionId}` === key);
    if (!item) return;
    this.sel = item.sessionId;
    cx.notify();
    const links = linksOf(item);
    // A Claude Code session in a live terminal with no checklist yet can be asked to show one.
    const showChecklist = Boolean(item.terminal) && item.raw?.t === "s" && !item.hasChecklist;
    const stopId = item.backgrounded ? item.raw.jobId ?? item.where.attachId ?? null : null;
    openOverlay({ mod: "fm-squad", kind: "popup", ...(at ? { at } : {}), width: LINKS_W, height: linksMenuHeight(links.length, showChecklist, Boolean(stopId)),
      props: { role: "links", head: ticketOf(item) ?? (item.spot?.slack ? "Slack" : item.spot?.label ?? "Session"),
        topic: item.topic ?? item.title ?? null, links, showChecklist, stopId, terminal: item.terminal ?? null,
        working: item.raw?.status === "busy" } });
  }

  // ---- the published state ----

  messageOf(item) {
    const lead = this.leadOf(item);
    const text = cleanMessage(lead?.text);
    if (text) return { text, quiet: Boolean(lead.waiting), spinner: Boolean(lead.spinner) };
    const prompt = item.raw.lastPrompt;
    if (!prompt || /\.claude\/handoff\//.test(prompt)) return null;
    const quiet = cleanMessage(prompt.replace(/\[Image #\d+\]/g, " ").replace(/(?:~|\/)[\w.-]*(?:\/[\w.-]+){2,}/g, " "));
    return quiet ? { text: `↳ ${quiet}`, quiet: true, spinner: false } : null;
  }

  // What a working session does now, what a waiting one asks, what a done one said.
  leadOf(item) {
    if (item.group === "working") {
      const waiting = item.raw.status === "shell";
      if (waiting && item.nowLabel) return { text: `▶ ${item.nowLabel}`, waiting: false, spinner: false };
      if (!waiting && !item.nowLine) return null;
      return { text: waiting ? "Waiting on background tasks" : item.nowLine, waiting, spinner: !waiting };
    }
    if (item.group === "attention") return { text: item.answer, waiting: false, spinner: false };
    return item.replyTail ? { text: item.replyTail, waiting: false, spinner: false } : null;
  }

  minsOf(item, now) {
    if (item.group === "done") return minutesOf(now - (item.sortDate ?? now));
    return minutesOf(now - (item.since ?? now));
  }

  minsLabel(item, now) {
    if (item.group === "done") {
      const minutes = this.minsOf(item, now);
      if (minutes < 1) return "now";
      return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
    }
    if (item.group === "working" && item.etaMinutes) return `~${item.etaMinutes}'`;
    return `${this.minsOf(item, now)}'`;
  }

  sessionReports(item) {
    return (item.pages ?? []).map((page, index) => ({
      id: page.pageId ?? `p${index}`,
      title: clean(page.label) ?? "Match report",
      time: clockText(page.createdAt),
      unread: !this.readReports.includes(pageReportKey(page)),
    }));
  }

  planOf(item) {
    if (!item.progress) return null;
    const total = item.progress.total ?? 0;
    const steps = item.steps.map(planStep);
    let cur = steps.findIndex((step) => step.state === "cur");
    if (cur < 0) cur = total ? Math.min(item.progress.done ?? 0, total - 1) : 0;
    const top = this.expanded.has(item.sessionId)
      ? Math.min(this.stepTop[item.sessionId] ?? 0, this.stepMaxTop(item))
      : 0;
    return { done: item.progress.done ?? 0, total, cur, top, stale: item.progressStale, steps };
  }

  linksFor(item) {
    const jira = item.jiraKey && config.jiraBrowse ? `${config.jiraBrowse}${item.jiraKey}` : null;
    const pr = item.prLinks?.[0]?.url ?? null;
    const slack = item.slack && config.slackArchives
      ? `${config.slackArchives}${item.slack.channel}/p${item.slack.ts.replace(".", "")}` : null;
    const page = (item.pages ?? []).find((candidate) => candidate.openable)?.url ?? null;
    return { jira, pr, slack, page };
  }

  sessionValue(item, now) {
    return {
      key: item.sessionId,
      ticket: ticketOf(item),
      title: item.title,
      msg: this.messageOf(item)?.text ?? cleanMessage(item.answer) ?? null,
      state: stateOf(item),
      group: item.group,
      agent: agentKindOf(item),
      ground: groundOf(item),
      space: item.space ?? null,
      tab: item.tab ?? null,
      terminal: item.terminal ?? null,
      phase: item.round ?? null,
      mins: this.minsOf(item, now),
      minsLabel: this.minsLabel(item, now),
      plan: this.planOf(item),
      reports: this.sessionReports(item),
      pr: item.prTag ?? null,
      links: this.linksFor(item),
      viewed: Boolean(item.viewed),
    };
  }

  // Published only when it changes, since setShared redraws every mod.
  publish(data, focused) {
    const model = data.model;
    const all = [...model.attention, ...model.working, ...model.done];
    const needed = model.attention.filter((item) => item.bucket !== "stall");
    const counts = {
      needs: needed.length,
      stall: model.attention.length - needed.length,
      working: model.working.length,
      done: model.done.length,
    };
    const continues = needed[0] ?? null;
    const pages = (this.meta?.pages ?? []).slice().sort((a, b) => (a.oldestCreatedAt ?? a.createdAt ?? 0) - (b.oldestCreatedAt ?? b.createdAt ?? 0));
    const unread = pages.filter((page) => !this.readReports.includes(pageReportKey(page)));
    const nextPage = unread[0] ?? null;
    const nextSession = nextPage ? all.find((item) => item.sessionId === nextPage.sessionId || item.terminal === nextPage.terminalHandle) : null;
    const selKey = all.some((item) => item.sessionId === this.sel) ? this.sel : null;
    const { list, at } = this.history;
    const value = {
      counts,
      shape: shapeOf(model.counts),
      total: all.length,
      grounds: new Set(all.map(groundOf).filter(Boolean)).size,
      sel: selKey,
      query: this.query,
      groupFilter: ["attention", "working", "done"].includes(this.groupFilter) ? this.groupFilter : null,
      inboxFilter: INBOX_KINDS.includes(this.inboxFilter) ? this.inboxFilter : "all",
      places: this.places ?? {},
      continue: continues ? { key: continues.sessionId, ticket: ticketOf(continues), mins: this.minsOf(continues, data.now) } : null,
      reports: {
        unread: unread.length,
        next: nextPage ? { key: nextSession?.sessionId ?? nextPage.sessionId ?? null, ticket: nextSession ? ticketOf(nextSession) : null, title: clean(nextPage.label) ?? "Match report" } : null,
        unreadable: this.meta?.unreadablePages?.length ?? 0,
      },
      history: { canBack: at > 0, canFwd: at >= 0 && at < list.length - 1 },
      sessions: all.map((item) => this.sessionValue(item, data.now)),
    };
    const text = JSON.stringify(value);
    if (text !== this.published) {
      this.published = text;
      setShared(SQUAD_KEY, value);
    }
    const selText = JSON.stringify({ key: selKey });
    if (selText !== this.publishedSel) {
      this.publishedSel = selText;
      setShared(SEL_KEY, { key: selKey });
    }
    this.publishNotice();
    this.orderAgents(all);
  }

  // agent.next / agent.prev follow the table's order.
  orderAgents(all) {
    const addresses = all.map((item) => item.terminal).filter(Boolean);
    const text = addresses.join("|");
    if (text === this.agentOrder) return;
    this.agentOrder = text;
    setAgentOrder(addresses);
  }

  publishNotice() {
    const value = this.err
      ? { tone: "err", text: this.err, action: "Retry" }
      : this.notice
        ? { tone: "note", text: this.notice, action: this.noticeAction?.label ?? null }
        : null;
    const text = JSON.stringify(value);
    if (text === this.publishedNotice) return;
    this.publishedNotice = text;
    setShared(NOTICE_KEY, value);
  }

  // ---- the Squad table (default role) ----

  head(data) {
    const all = [...data.model.attention, ...data.model.working, ...data.model.done];
    const grounds = new Set(all.map(groundOf).filter(Boolean)).size;
    return h_flex().h(46).flex_none().px(18).items_center().gap(10)
      .child(display("SQUAD", FS.h))
      .child(h_flex().h(22).flex_none().px(8).rounded(R.pill).bg(C.panel3).items_center()
        .child(display(`Shape ${data.shape}`, FS.md)))
      .child(div().flex_none().max_w(320).min_w(0).truncate().text_size(FS.sm).font_family(FONT.body)
        .text_color(C.ink3).child(`${all.length} in the squad across ${grounds} grounds`))
      .child(h_flex().flex_1().min_w(0).justify_end()
        .child(div().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink3)
          .child("←→ select, ↩ watch, ⌫ sub off, ↑↓ phases")));
  }

  shownColumns() {
    return visibleColumns(this.width);
  }

  columns() {
    const ids = new Set(this.shownColumns());
    const cell = (col) => {
      const box = h_flex().flex_none().items_center().when(col.align === "right", (el) => el.justify_end())
        // "No" is right-aligned against "Ticket"; the gap keeps the header from reading "NoTicket".
        .when(col.id === "no", (el) => el.pr(10));
      if (col.flex) box.flex_1().min_w(0); else box.w(col.w);
      return box.child(div().min_w(0).truncate().text_size(FS.xs).font_family(FONT.body).font_semibold()
        .text_color(C.ink3).child(col.label));
    };
    return h_flex().h(26).flex_none().pr(10).items_center()
      .child(div().w(3).flex_none())
      .children(COLUMNS.filter((col) => ids.has(col.id)).map(cell));
  }

  groupRow(entry) {
    const group = entry.group;
    return h_flex().h(40).w_full().flex_none().pl(14).pr(10).items_center().gap(8)
      .child(div().w(3).h(12).flex_none().rounded(2).bg(group.color))
      .child(display(group.title, FS.md))
      .child(display(String(group.count), FS.md, C.ink2))
      .child(text(group.hint, FS.sm, C.ink3));
  }

  moreRow(entry) {
    return h_flex().h(38).w_full().flex_none().items_center().justify_center().cursor_pointer()
      .id(entry.key)
      .on_click((_event, cx) => this.clickRow(entry.key, cx))
      .hover((style) => style.bg(C.veil1))
      .child(text(`+${entry.count} more at full time`, FS.sm, C.ink3));
  }

  tableRow(entry, data) {
    const item = entry.item;
    const state = stateOf(item);
    const selected = item.sessionId === this.sel;
    const message = this.messageOf(item);
    const now = data.now;
    const mins = this.minsLabel(item, now);
    const plan = this.planOf(item);
    const reports = this.sessionReports(item);
    const bg = selected ? C.panel3 : entry.alt ? C.rowAlt : "#00000000";
    const ids = new Set(this.shownColumns());
    const cells = {
      si: (col) => h_flex().w(col.w).flex_none().items_center().justify_center().child(statusSquare(state)),
      no: (col) => h_flex().w(col.w).flex_none().justify_end().items_center().pr(10)
        .child(display(String(entry.number), FS.lg, C.ink3)),
      ticket: (col) => h_flex().w(col.w).flex_none().items_center()
        .child(display(ticketOf(item) ?? "—", FS.lg, selected ? C.focusKb : C.ink)),
      brief: () => v_flex().flex_1().min_w(0).justify_center()
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(FS.md).font_family(FONT.body).font_semibold().text_color(C.ink).child(item.title))
          .when(Boolean(item.backgrounded), (el) => el.child(h_flex().h(18).px(6).flex_none().rounded(R.r2).bg(C.panel3).items_center()
            .child(text("Background", FS.xs, C.ink2)))))
        .child(div().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body)
          .text_color(item.group === "working" && message?.spinner ? C.working : C.ink3)
          .child(message?.text ?? "")),
      nat: (col) => h_flex().w(col.w).flex_none().items_center().child(natFlag(agentKindOf(item))),
      ground: (col) => h_flex().w(col.w).flex_none().items_center()
        .child(div().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink2).child(groundOf(item) ?? "—")),
      phase: (col) => h_flex().w(col.w).flex_none().items_center()
        .child(display(item.round ?? "", FS.md, C.ink2)),
      mins: (col) => h_flex().w(col.w).flex_none().items_center().gap(3)
        .child(display(mins, FS.lg, state === "needs" ? C.needs : state === "stall" ? C.stall : C.ink2))
        .when(state === "stall", (el) => el.child(text("quiet", FS.xs, C.ink3))),
      plan: (col) => h_flex().w(col.w).flex_none().items_center()
        .when(Boolean(plan), (el) => el.child(this.planBar(plan))),
      rpt: (col) => h_flex().w(col.w).flex_none().items_center()
        .when(reports.length > 0, (el) => el.child(
          h_flex().h(22).px(6).gap(4).rounded(R.r2).bg(C.panel3).items_center()
            .child(pageGlyph(11, C.ink2))
            .child(display(String(reports.length), FS.sm, C.ink2)))),
      pr: (col) => h_flex().w(col.w).flex_none().items_center()
        .child(div().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink2).child(item.prTag ?? "")),
    };
    const row = h_flex().h(52).w_full().flex_none().pr(10).items_center().bg(bg).cursor_pointer()
      .id(entry.key)
      .on_click((_event, cx) => this.clickRow(entry.key, cx))
      .on_mouse_down("right", (_event, cx) => this.openLinks(entry.key, cx))
      .when(!selected, (el) => el.hover((style) => style.bg(C.veil1)))
      .child(div().w(3).h_full().flex_none().bg(selected ? C.focusKb : "#00000000"))
      .children(COLUMNS.filter((col) => ids.has(col.id)).map((col) => cells[col.id](col)))
      .when(item.group === "done" && item.viewed && !selected, (el) => el.opacity(0.55))
      .tooltip(`${item.topic ?? item.title}\n${groundOf(item) ?? ""}${item.spot?.label ? ` · ${item.spot.label}` : ""}`);
    return row;
  }

  planBar(plan) {
    const total = plan.total ?? 0;
    const segments = [];
    for (let i = 0; i < total; i++) {
      const color = i < plan.done ? C.working : i === plan.cur ? C.focusKb : C.barTrack;
      segments.push(div().flex_1().h(5).rounded(2).bg(color));
    }
    return h_flex().gap(6).items_center()
      .when(Boolean(plan.stale), (el) => el.opacity(0.45))
      .child(h_flex().w(84).flex_none().gap(3).h(5).children(segments))
      .child(text(`${plan.done}/${total}`, FS.xs, C.ink2));
  }

  table(data) {
    const rows = this.tableRows(data);
    const hasItems = rows.some((entry) => entry.kind === "row");
    if (!hasItems) {
      return v_flex().flex_1().items_center().justify_center()
        .child(text(emptyText(this.query), FS.md, C.ink3));
    }
    return v_flex().id("squad-rows").flex_1().min_h(0).w_full().overflow_y_scroll().track_scroll(this.scroll)
      .children(rows.map((entry) => {
        if (entry.kind === "group") return this.groupRow(entry);
        if (entry.kind === "more") return this.moreRow(entry);
        return this.tableRow(entry, data);
      }));
  }

  clickRow(key, cx) {
    if (key === "more-done") {
      this.showAllDone = true;
    } else {
      const item = this.viewData().allGroups.flatMap((group) => group.items)
        .find((entry) => `row-${entry.sessionId}` === key);
      if (!item) return;
      this.sel = item.sessionId;
      this.goTo(item, cx);
    }
    this.handle.focus();
    cx.notify();
  }

  legend() {
    const rows = [
      ["←→", "Select"], ["↩", "Watch live"], ["↑↓", "Phases"], ["⌫", "Sub off, rest"],
      ["⌘Z", "Undo"], ["Space", "Continue"], ["⇧Space", "Next full time"], ["⌘↩", "Dossier"],
      ["Tab", "Next match report"], ["Esc", "Back"], ["⌥←", "First"], ["⇧↩", "Match report"],
    ];
    const item = ([keys, label]) => h_flex().flex_none().h(24).gap(6).items_center()
      .child(keycap(keys))
      .child(text(label, FS.sm, C.ink2));
    const half = Math.ceil(rows.length / 2);
    return v_flex().absolute().top(50).right(16).w(360).p(12).rounded(R.r3).bg(C.panel2).border(1).border_color(C.line2)
      .child(h_flex().items_center().mb(8)
        .child(display("KEYS", FS.md))
        .child(div().flex_1())
        .child(keycap("?")))
      .child(h_flex().items_start().gap(16)
        .child(v_flex().flex_1().gap(2).children(rows.slice(0, half).map(item)))
        .child(v_flex().flex_1().gap(2).children(rows.slice(half).map(item))));
  }

  // ---- the player overview (props role "overview") ----

  selectedFrom(sq) {
    const sessions = Array.isArray(sq?.sessions) ? sq.sessions : [];
    return sessions.find((session) => session?.key === sq?.sel) ?? null;
  }

  overview() {
    const sq = shared(SQUAD_KEY) ?? {};
    const sel = this.selectedFrom(sq);
    if (!sel) {
      return v_flex().size_full().items_center().justify_center().gap(6)
        .child(display("NO SESSION SELECTED", FS.lg, C.ink3))
        .child(text("←→ select, ↩ watch live", FS.sm, C.ink4));
    }
    const st = STATE[sel.state] ?? STATE.working;
    const band = BAND[sel.state] ?? BAND.working;
    const planHint = sel.plan && Number.isFinite(sel.plan.total)
      ? `phase ${Math.min((sel.plan.cur ?? 0) + 1, sel.plan.total)} of ${sel.plan.total}, ↑↓`
      : null;
    return v_flex().size_full().min_h(0).overflow_y_scroll()
      .child(this.overviewHead(sel, st, band))
      .child(this.overviewStats(sel))
      .child(this.section("Commentary", null))
      .child(this.commentaryBox(sel))
      .child(this.section("Game plan", planHint))
      .child(this.overviewPlan(sel))
      .child(this.section("Match reports", null))
      .child(this.overviewReports(sel))
      .child(this.overviewActions(sel));
  }

  overviewHead(sel, st, band) {
    const tags = [];
    const statePill = h_flex().h(22).flex_none().px(10).rounded(R.pill).bg(C.shade2).gap(5).items_center();
    if (sel.state === "working") statePill.child(spinner(10));
    statePill.child(div().text_size(FS.sm).font_family(FONT.body).font_semibold().text_color(C.veilInk).child(st.label));
    tags.push(statePill);
    const nat = NAT[sel.agent] ?? NAT.claude;
    tags.push(h_flex().h(22).flex_none().px(10).rounded(R.pill).bg(C.shade2).gap(5).items_center()
      .child(div().w(14).h(10).rounded(2).bg(nat.color))
      .child(text(nat.name, FS.sm, C.veilInk).font_semibold()));
    if (sel.phase) tags.push(pill(`Phase ${sel.phase}`, { bg: C.shade2, color: C.veilInk }));
    if (sel.pr) tags.push(pill(sel.pr, { bg: C.shade2, color: C.veilInk }));
    if (sel.ground) tags.push(pill(sel.ground, { bg: C.shade2, color: C.veilInk }));
    return v_flex().relative().flex_none().px(20).pt(16).pb(14).overflow_hidden()
      .child(gradientFill(band[0], band[1]))
      .child(display(sel.ticket ?? sel.title, FS.hero, C.ink))
      .child(div().mt(4).text_size(FS.lg).font_family(FONT.body).font_semibold().text_color(C.ink2).child(sel.title ?? ""))
      .child(h_flex().mt(10).flex_wrap().gap(5).children(tags));
  }

  overviewStats(sel) {
    const added = typeof sel.minsLabel === "string" && sel.minsLabel.startsWith("~") ? sel.minsLabel : "—";
    const cells = [
      ["Minutes", `${sel.mins ?? 0}'`, sel.state === "working"],
      ["Added time", added, false],
      ["Game plan", sel.plan ? `${sel.plan.done}/${sel.plan.total}` : "—", false],
      ["Match reports", String(sel.reports?.length ?? 0), false],
    ];
    return h_flex().flex_none().px(8).py(4).children(cells.map(([label, value, live], index) => v_flex().flex_1().px(14).py(8)
      .when(index < cells.length - 1, (el) => el.border_r(1).border_color(C.lineSoft))
      .child(text(label, FS.xs, C.ink3).font_semibold())
      .child(display(value, FS.h, live ? C.working : C.ink))));
  }

  section(title, hint) {
    return h_flex().px(20).pt(14).pb(6).items_center()
      .child(display(title.toUpperCase(), FS.lg))
      .child(div().flex_1())
      .when(Boolean(hint), (el) => el.child(text(hint, FS.sm, C.ink3)));
  }

  commentaryBox(sel) {
    const body = text(sel.msg ?? "—", FS.md, C.ink);
    const inner = h_flex().gap(6).items_start();
    if (sel.state === "working") {
      inner.child(h_flex().h(20).flex_none().px(8).rounded(R.pill).bg(C.workingBand).items_center()
        .child(text("now", FS.sm, C.working).font_semibold()));
    }
    inner.child(v_flex().flex_1().min_w(0).child(body));
    return h_flex().mx(20).px(14).py(12).rounded(R.r2).bg(C.veil1).child(inner);
  }

  overviewPlan(sel) {
    const plan = sel.plan;
    if (!plan) return h_flex().px(20).pb(8).child(text("No game plan yet", FS.sm, C.ink4));
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const top = plan.top ?? 0;
    const rows = steps.slice(top, top + STEP_ROWS()).map((step, index) => {
      const cur = top + index === plan.cur;
      const glyph = step?.state === "ok"
        ? div().text_size(FS.sm).font_family(FONT.body).font_bold().text_color(C.working).child("✓")
        : step?.state === "cur"
          ? spinner(11)
          : div().text_size(FS.sm).font_family(FONT.body).text_color(C.ink4).child("○");
      return h_flex().h(28).rounded(R.r1).px(6).mx(-6).gap(8).items_center()
        .when(cur, (el) => el.bg(C.workingBand))
        .child(h_flex().w(22).flex_none().items_center().justify_center().child(glyph))
        .child(div().flex_1().min_w(0).truncate().text_size(FS.base).font_family(FONT.body)
          .text_color(cur ? C.ink : C.ink2).child(step?.text ?? ""))
        .when(Boolean(step?.note), (el) => el.child(text(step.note, FS.xs, C.ink3)));
    });
    return v_flex().px(20).pb(8).children(rows);
  }

  overviewReports(sel) {
    const reports = Array.isArray(sel.reports) ? sel.reports : [];
    if (!reports.length) return h_flex().px(20).pb(12).child(text("No match report yet", FS.sm, C.ink4));
    return h_flex().flex_wrap().gap(6).px(20).pb(12).children(reports.map((report) =>
      h_flex().h(24).flex_none().px(10).rounded(R.pill).bg(C.panel2).gap(5).items_center()
        .child(pageGlyph(11, C.link))
        .child(text(report?.title, FS.sm, C.ink))));
  }

  overviewActions(sel) {
    const key = sel.key;
    const action = (label, hint, primary, run) => {
      const button = h_flex().h(36).flex_1().rounded(R.r2).px(12).items_center().justify_between().cursor_pointer()
        .on_click((_event, _cx) => run());
      if (primary) {
        return div().relative().h(36).flex_1().rounded(R.r2).overflow_hidden().cursor_pointer()
          .on_click((_event, _cx) => run())
          .child(gradientFill(C.accent2, C.accent))
          .child(h_flex().h_full().px(12).items_center().justify_between()
            .child(text(label, FS.base, C.accentInk).font_semibold())
            .child(text(hint, FS.sm, C.accentInk).font_semibold()));
      }
      return button.border(1).border_color(C.line2)
        .child(text(label, FS.base, C.ink).font_semibold())
        .child(text(hint, FS.sm, C.ink3));
    };
    const write = (name, args = {}) => this.writeCmd(name, args);
    return v_flex().mt(8).pt(14).px(20).pb(18).gap(8)
      .child(h_flex().gap(8)
        .child(action("Watch live", "↩", true, () => write("go", { key })))
        .child(action("Dossier", "⌘↩", false, () => write("links", { key }))))
      .child(h_flex().gap(8)
        .child(action("Match report", "⇧↩", false, () => write("report", { key })))
        .child(action("Sub off", "⌫", false, () => write("release", { key }))));
  }

  // ---- the Inbox (props role "inbox") ----

  // fm-chrome's sub tabs and the inbox's own chips both write fm.cmd; fm.squad carries the choice
  // back, so a change made on either side reaches the other.
  inboxFilterFor(sq) {
    const kind = INBOX_KINDS.includes(sq?.inboxFilter) ? sq.inboxFilter : null;
    if (kind && kind !== this.seenFilter) this.filter = kind;
    this.seenFilter = kind;
    return INBOX_KINDS.includes(this.filter) ? this.filter : "all";
  }

  inbox() {
    const sq = shared(SQUAD_KEY) ?? {};
    const sessions = Array.isArray(sq.sessions) ? sq.sessions.filter(Boolean) : [];
    const touchline = sessions.filter((session) => session.group === "attention");
    const reportRows = [];
    for (const session of sessions) {
      const reports = Array.isArray(session.reports) ? session.reports : [];
      for (const report of reports) if (report) reportRows.push({ session, report });
    }
    const filter = this.inboxFilterFor(sq);
    const showTouchline = filter !== "reports";
    const showReports = filter !== "touchline";
    const unread = reportRows.filter((row) => row.report.unread).length;
    const chosen = this.inboxChoice(sq, sessions, reportRows);
    const left = v_flex().w(520).flex_none().h_full().min_h(0).pr(12)
      .child(h_flex().px(16).pt(12).pb(6).items_center()
        .child(display("INBOX", FS.h))
        .child(div().flex_1()))
      .child(h_flex().px(16).pb(8).gap(6)
        .child(this.inboxFilter("All", "all", filter))
        .child(this.inboxFilter(`Touchline (${touchline.length})`, "touchline", filter))
        .child(this.inboxFilter(`Match reports (${unread})`, "reports", filter)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll()
        .when(showTouchline, (el) => el
          .child(h_flex().px(16).pt(10).pb(4).child(display("TOUCHLINE", FS.sm, C.ink3)))
          .children(touchline.map((session) => this.inboxSessionRow(session, chosen))))
        .when(showReports, (el) => el
          .child(h_flex().px(16).pt(10).pb(4).child(display("MATCH REPORTS", FS.sm, C.ink3)))
          .children(reportRows.map((row) => this.inboxReportRow(row, chosen)))));
    return h_flex().size_full().min_h(0).child(left).child(v_flex().flex_1().min_h(0).border_l(1).border_color(C.lineSoft)
      .child(chosen ? this.inboxBody(chosen) : this.inboxEmpty()));
  }

  inboxChoice(sq, sessions, reportRows) {
    const picked = this.picked;
    // A selection made elsewhere wins over a row picked here before the squad published it.
    if (this.lastSel !== undefined && sq?.sel !== this.lastSel) this.picked = null;
    this.lastSel = sq?.sel;
    if (picked?.kind === "report") {
      const row = reportRows.find((entry) => entry.session.key === picked.key && entry.report.id === picked.id);
      return row ? { kind: "report", ...row } : null;
    }
    // A row picked here whose session vanished has no body to show; the empty state stands in.
    if (picked?.kind === "session") {
      const row = sessions.find((entry) => entry.key === picked.key);
      return row ? { kind: "session", session: row } : null;
    }
    const wanted = this.picked?.key ?? sq?.sel;
    const session = sessions.find((entry) => entry.key === wanted) ?? sessions.find((entry) => entry.group === "attention") ?? sessions[0];
    return session ? { kind: "session", session } : null;
  }

  inboxFilter(label, value, active) {
    const on = active === value;
    return h_flex().h(26).flex_none().px(10).rounded(R.pill).items_center().cursor_pointer()
      .bg(on ? C.select : C.panel2)
      .on_click((_event, cx) => { this.filter = value; this.writeCmd("inbox-filter", { kind: value }); cx.notify(); })
      .hover((style) => (on ? style : style.bg(C.panel3)))
      .child(text(label, FS.sm, on ? C.accentInk : C.ink2).font_semibold());
  }

  inboxSessionRow(session, chosen) {
    const selected = chosen?.kind === "session" && chosen.session.key === session.key;
    const st = STATE[session.state] ?? STATE.needs;
    return h_flex().h(58).w_full().flex_none().px(16).gap(10).items_center().cursor_pointer()
      .bg(selected ? C.panel3 : "#00000000")
      .when(selected, (el) => el.border_l(3).border_color(C.focusKb))
      .when(!selected, (el) => el.hover((style) => style.bg(C.veil1)))
      .on_click((_event, cx) => {
        this.picked = { kind: "session", key: session.key };
        this.writeCmd("select", { key: session.key });
        cx.notify();
      })
      .child(statusSquare(session.state))
      .child(v_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink2)
          .child(`${session.ticket ?? session.ground ?? "Session"}, ${session.ground ?? st.label}`))
        .child(div().min_w(0).truncate().text_size(FS.md).font_family(FONT.body).font_semibold().text_color(C.ink).child(session.title ?? "")))
      .child(h_flex().flex_none().items_center()
        .child(display(session.minsLabel ?? "", FS.lg, session.state === "needs" ? C.needs : session.state === "stall" ? C.stall : C.ink2)));
  }

  inboxReportRow(row, chosen) {
    const selected = chosen?.kind === "report" && chosen.session.key === row.session.key && chosen.report.id === row.report.id;
    return h_flex().h(52).w_full().flex_none().px(16).gap(10).items_center().cursor_pointer()
      .bg(selected ? C.panel3 : "#00000000")
      .when(selected, (el) => el.border_l(3).border_color(C.focusKb))
      .when(!selected, (el) => el.hover((style) => style.bg(C.veil1)))
      .on_click((_event, cx) => {
        this.picked = { kind: "report", key: row.session.key, id: row.report.id };
        this.writeCmd("select", { key: row.session.key });
        cx.notify();
      })
      .child(h_flex().size(22).flex_none().rounded(R.r2).bg(C.panel3).items_center().justify_center().child(pageGlyph(11, C.done)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink2)
          .child(`${row.session.ticket ?? row.session.ground ?? "Session"}, Match report`))
        .child(div().min_w(0).truncate().text_size(FS.md).font_family(FONT.body)
          .font_semibold().text_color(C.ink).when(row.report.unread, (el) => el.font_bold()).child(row.report.title ?? "")))
      .child(h_flex().flex_none().items_center().child(text(row.report.time ?? "", FS.sm, C.ink3)));
  }

  inboxBody(chosen) {
    const session = chosen.session;
    const report = chosen.kind === "report" ? chosen.report : null;
    const header = h_flex().gap(10).items_center()
      .child(statusSquare(session.state))
      .child(text(session.ticket ?? session.ground ?? "Session", FS.sm, C.ink2).font_bold())
      .when(Boolean(session.phase), (el) => el.child(text(`Phase ${session.phase}`, FS.sm, C.ink2)))
      .child(natFlag(session.agent))
      .child(text(session.ground ?? "", FS.sm, C.ink2))
      .child(text(this.inboxTimeLine(session), FS.sm, C.ink3));
    const title = report ? report.title : session.title;
    const attachment = (Array.isArray(session.reports) ? session.reports : [])[0] ?? null;
    const attachmentChip = h_flex().flex_none().gap(10).px(12).py(10).rounded(R.r1)
      .bg(C.panel2).border(1).border_color(C.line).items_center()
      .child(pageGlyph(18, C.link))
      .child(v_flex().child(text(attachment?.title ?? "", FS.base, C.ink))
        .child(text(`Match report, ${attachment?.time ?? ""}`, FS.xs, C.ink3)));
    return v_flex().size_full().min_h(0)
      .child(v_flex().px(20).pt(18).pb(14).gap(8)
        .child(header)
        .child(display(title ?? "", FS.h3)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll().px(20).py(16)
        .child(v_flex().max_w(620).gap(12)
          .child(text(session.msg ?? "—", FS.lg, C.ink).line_height("26px"))
          .when(Boolean(attachment), (el) => el.child(attachmentChip))))
      .child(this.inboxActions(session, report));
  }

  inboxTimeLine(session) {
    if (session.state === "needs") return `on the touchline for ${session.mins ?? 0} min`;
    if (session.state === "stall") return `quiet for ${session.mins ?? 0} min`;
    if (session.state === "working") return `in possession for ${session.mins ?? 0} min`;
    return "at full time";
  }

  inboxActions(session, report) {
    const key = session.key;
    const primaryLabel = report ? "Open report ↩" : "Give instructions ↩";
    const write = (name, args = {}) => this.writeCmd(name, args);
    const button = (label, hint, primary, handler) => {
      if (primary) {
        return div().relative().h(36).flex_none().rounded(R.r2).overflow_hidden().cursor_pointer()
          .on_click((_event, _cx) => handler())
          .child(gradientFill(C.accent2, C.accent))
          .child(h_flex().h_full().px(14).gap(6).items_center()
            .child(text(label, FS.base, C.accentInk).font_semibold())
            .child(text(hint, FS.sm, C.accentInk).font_semibold()));
      }
      return h_flex().h(36).flex_none().px(14).gap(6).rounded(R.r2).border(1).border_color(C.line2)
        .items_center().cursor_pointer().on_click((_event, _cx) => handler())
        .hover((style) => style.bg(C.veil1))
        .child(text(label, FS.base, C.ink).font_semibold())
        .child(text(hint, FS.sm, C.ink3));
    };
    return h_flex().flex_none().px(20).py(12).gap(8).items_center()
      .child(button(primaryLabel, "↩", true, () => (report ? write("report", { key, id: report.id }) : write("go", { key }))))
      .child(button("Dossier", "⌘↩", false, () => write("links", { key })))
      .child(button("Match report", "⇧↩", false, () => write("report", { key })))
      .child(div().flex_1())
      .child(button("Next touchline call", "Space", false, () => write("continue")));
  }

  inboxEmpty() {
    return v_flex().size_full().items_center().justify_center().gap(6).px(24)
      .child(text(INBOX_EMPTY.title, FS.lg, C.ink2))
      .child(div().max_w(420).text_size(FS.sm).font_family(FONT.body).text_color(C.ink3)
        .child(INBOX_EMPTY.hint));
  }

  writeCmd(name, args = {}) {
    setShared(CMD_KEY, { token: `${Date.now()}-${Math.random()}`, name, args });
  }

  // ---- the Dossier popup (props role "links") ----

  linksMenu() {
    const { head, topic, links = [], showChecklist = false, stopId = null } = props() ?? {};
    const rows = [...(stopId ? [{ stop: true }] : []), ...(showChecklist ? [{ checklist: true }] : []), ...links];
    const row = (id, label, meta, hot, active, action) => h_flex().id(id).h(34).flex_none().px(8).gap(8).rounded(R.r1)
      .items_center().cursor_pointer()
      .when(active, (el) => el.bg(C.panel3))
      .hover((style) => style.bg(C.veil1))
      .on_click((_event, cx) => action(cx))
      .child(div().flex_1().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).font_semibold().text_color(C.ink).child(label))
      .when(Boolean(meta), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(FS.xs).font_family(FONT.body)
        .text_color(C.ink3).child(meta)))
      .when(Boolean(hot), (el) => el.child(keycap(String(hot).toUpperCase())));
    const checklistRow = h_flex().id("link-checklist").h(34).flex_none().px(8).gap(8).rounded(R.r1)
      .items_center().cursor_pointer()
      .when(this.active === (stopId ? 1 : 0), (el) => el.bg(C.panel3))
      .hover((style) => style.bg(C.veil1))
      .on_click((_event, cx) => this.enableChecklist(cx))
      .child(div().flex_1().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).font_semibold().text_color(C.ink)
        .child("Show game plan"))
      .child(text("deadhd checklist", FS.xs, C.ink3))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(FS.xs)
        .font_family(FONT.body).text_color(C.needs).child(this.error)))
      .child(keycap("C"));
    const stopRow = h_flex().id("link-stop").h(34).flex_none().px(8).gap(8).rounded(R.r1)
      .items_center().cursor_pointer()
      .when(this.active === 0, (el) => el.bg(C.panel3))
      .hover((style) => style.bg(C.veil1))
      .on_click((_event, cx) => this.stopSession(cx))
      .child(div().flex_1().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body).font_semibold().text_color(C.ink)
        .child("Stop background session"))
      .when(Boolean(this.stopError), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(FS.xs)
        .font_family(FONT.body).text_color(C.needs).child(this.stopError)))
      .child(keycap("X"));
    const offset = (stopId ? 1 : 0) + (showChecklist ? 1 : 0);
    return v_flex().id("fm-dossier").size_full().p(8).track_focus(this.handle)
      .on_key_down((event, cx) => this.linksKey(event.key, rows, cx))
      .child(v_flex().h(38).flex_none().px(8).pt(2)
        .child(h_flex().items_center()
          .child(display("Dossier", FS.lg))
          .child(div().flex_1())
          .when(Boolean(head), (el) => el.child(text(head, FS.xs, C.ink2))))
        .when(Boolean(topic), (el) => el.child(div().min_w(0).truncate().text_size(FS.xs).font_family(FONT.body).text_color(C.ink3).child(topic))))
      .child(div().h(1).mx(6).mb(4).flex_none().bg(C.lineSoft))
      .when(Boolean(stopId), (el) => el.child(stopRow).child(div().h(1).mx(6).my(4).flex_none().bg(C.lineSoft)))
      .when(showChecklist, (el) => el.child(checklistRow))
      .when(showChecklist && links.length > 0, (el) => el.child(div().h(1).mx(6).my(4).flex_none().bg(C.lineSoft)))
      .when(links.length === 0, (el) => el.child(h_flex().h(34).px(8).items_center()
        .child(text("No links on this session", FS.sm, C.ink3))))
      .children(links.map((link, index) => row(`link-${index}`, link.label, link.meta, link.hot,
        index + offset === this.active, (cx) => this.openLink(link, cx))))
      .when(links.length > 0, (el) => el
        .child(div().h(1).mx(6).my(4).flex_none().bg(C.lineSoft))
        .child(row("link-copy", "Copy all links", null, null, false, (cx) => this.copyLinks(links, cx))));
  }

  // A row's letter runs it, ↑↓ move, ↩ runs the highlighted row, Esc closes.
  linksKey(key, rows, cx) {
    const hot = rows.find((row) => (row.stop ? key === "x" : row.checklist ? key === "c" : row.hot === key));
    if (hot?.stop) this.stopSession(cx);
    else if (hot?.checklist) this.enableChecklist(cx);
    else if (hot) this.openLink(hot, cx);
    else if (key === "down" && rows.length) this.active = (this.active + 1) % rows.length;
    else if (key === "up" && rows.length) this.active = (this.active - 1 + rows.length) % rows.length;
    else if (key === "enter" && rows[this.active]) {
      if (rows[this.active].stop) this.stopSession(cx);
      else if (rows[this.active].checklist) this.enableChecklist(cx);
      else this.openLink(rows[this.active], cx);
    } else if (key === "escape") closeOverlay(props().overlay);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Asks the session to show its game plan through Herdr's CLI; inputs arrive as positional args.
  enableChecklist(cx) {
    const { terminal, working, overlay } = props() ?? {};
    if (!terminal) return;
    const prompt = working ? CHECKLIST_QUEUED_PROMPT : CHECKLIST_PROMPT;
    this.error = null;
    cx.spawn(async (cx) => {
      let result = null;
      try { result = await exec("sh", ["-lc", 'hc send "$1" "$2"', "x", terminal, prompt]); } catch {}
      if (!result || result.code !== 0) {
        this.error = (((result?.stderr || result?.stdout) ?? "").trim().replace(/\.$/, ""))
          || "Could not reach the terminal — focus it in Herdr and retry";
        cx.notify();
        return;
      }
      closeOverlay(overlay);
    });
  }

  // `claude stop` keeps the conversation, so `claude attach` can bring it back. The popup is closed only
  // after the command returns: closing it ends this copy.
  stopSession(cx) {
    const { stopId, overlay } = props() ?? {};
    if (!stopId) return;
    this.stopError = null;
    cx.spawn(async (cx) => {
      let result = null;
      try { result = await exec("sh", ["-lc", 'claude stop "$1"', "x", stopId]); } catch {}
      if (!result || result.code !== 0) {
        this.stopError = (((result?.stderr || result?.stdout) ?? "").trim().replace(/\.$/, ""))
          || "Could not stop it — run claude stop in a terminal";
        cx.notify();
        return;
      }
      closeOverlay(overlay);
    });
  }

  // http(s) goes to the system's URL handler; a local report file (scan.sh vouched it openable) to `open`.
  openLink(link, cx) {
    if (/^https?:\/\//.test(link.url)) cx.open_url(link.url);
    else exec("open", [link.url]);
    closeOverlay(props().overlay);
  }

  copyLinks(links, cx) {
    cx.write_to_clipboard(links.map((link) => link.url).join("\n"));
    closeOverlay(props().overlay);
  }

  render(cx) {
    if (this.role === "overview") return this.overview();
    if (this.role === "inbox") return this.inbox();
    if (this.role === "links") return this.linksMenu();
    this.drawnFocus = this.focusKey();
    const data = this.viewData();
    this.followFocus(data);
    const selected = this.selectedItem(data);
    if (selected) {
      this.sel = selected.sessionId;
      this.selIndex = Math.max(0, data.groups.flatMap((group) => group.items).indexOf(selected));
      this.handoff = false;
    }
    const focused = this.handle.is_focused();
    this.publish(data, focused);
    return v_flex().id("fm-squad").size_full().min_h(0).relative()
      .font_family(FONT.body).text_size(FS.base).text_color(C.ink)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (size.width === this.width) return;
        this.width = size.width;
        cx.notify();
      })
      .on_key_down((event, cx) => this.key(event, cx))
      .child(this.head(data))
      .child(this.columns())
      .child(this.table(data))
      .when(this.showKeys, (el) => el.child(this.legend()));
  }
}

// One column spec for the header row and every data row: the same widths, in the same order.
// Brief takes whatever is left; the rest are fixed so the header and the rows cannot drift.
export const COLUMNS = [
  { id: "si", label: "", w: 46 },
  { id: "no", label: "No", w: 30, align: "right" },
  { id: "ticket", label: "Ticket", w: 96 },
  { id: "brief", label: "Brief, commentary", flex: true },
  { id: "nat", label: "Nat", w: 70 },
  { id: "ground", label: "Ground", w: 150 },
  { id: "phase", label: "Ph", w: 34 },
  { id: "mins", label: "Mins", w: 78 },
  { id: "plan", label: "Game plan", w: 128 },
  { id: "rpt", label: "Rpt", w: 52 },
  { id: "pr", label: "PR", w: 60 },
];
// Narrow panels shed these in turn until the fixed columns plus a usable Brief fit.
export const COLUMN_DROP = ["pr", "rpt", "phase", "ground", "plan"];
const ROW_CHROME = 3 + 14 + 10;
const BRIEF_MIN = 120;

export function visibleColumns(width) {
  const drop = new Set();
  const needed = () => COLUMNS.reduce((sum, col) =>
    sum + (drop.has(col.id) ? 0 : col.flex ? BRIEF_MIN : col.w), ROW_CHROME);
  const sized = Number.isFinite(width) && width > 0;
  for (const id of COLUMN_DROP) {
    if (!sized || needed() <= width) break;
    drop.add(id);
  }
  return COLUMNS.filter((col) => !drop.has(col.id)).map((col) => col.id);
}

const STEP_ROWS = () => 9;
