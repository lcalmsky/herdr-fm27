// fm-staff: the Staff screen's backroom. Every Claude and Codex login, the custom commands and the
// Claude start command are rows with a contract: the radio marks the login new sessions sign under,
// and each login's rate-limit windows read as wage budgets. The shell work lives in `cca`.
// props().role "screen" draws the table; role "menu" with mode "add" the custom-command form.

import { View, div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, focused, run, exec, props, appHome, openOverlay, closeOverlay, knownAgents, shared, nextCommand } from "herdr";
import { C, FONT, FS, R } from "./tokens.js";

const FOCUS_WATCH_MS = 100;

// Account names go into a shell command line, so only these characters are accepted anywhere.
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
const RESERVED = new Set(["ls", "add", "share", "help"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Herdr has no API for a mod's own folder; the app home is where Herdr keeps mods.
const cca = () => `${appHome()}/mods/fm-staff/cca`;

// The command a resumed or new session starts with. The file keeps chiikawa-accounts' name on
// purpose: existing setups already have their start command written there.
const LAUNCH_FILE = '"${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower/chiikawa-launch"';
const MODELS_FILE = '"${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower/models.json"';
const DEFAULT_LAUNCH = "claude";
const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

async function readLaunch() {
  try {
    const r = await exec("sh", ["-c", `cat ${LAUNCH_FILE} 2>/dev/null`]);
    return (r?.stdout ?? "").trim() || DEFAULT_LAUNCH;
  } catch {
    return DEFAULT_LAUNCH;
  }
}

// The porcelain record carries only whether a model can resume, so the template comes from the
// models file, indexed by id; the first usable entry wins, as in models.mjs.
export function resumeTemplates(text) {
  let list;
  try {
    list = JSON.parse(String(text ?? ""));
  } catch {
    return {};
  }
  if (!Array.isArray(list)) return {};
  const out = {};
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.id !== "string" || !ACCOUNT_NAME.test(entry.id)) continue;
    if (typeof entry.command !== "string" || !entry.command.trim() || /[\t\r\n]/.test(entry.command)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (typeof entry.resume === "string" && entry.resume.trim() && !/[\t\r\n]/.test(entry.resume)) {
      out[entry.id] = entry.resume.trim();
    }
  }
  return out;
}

async function modelResumes() {
  try {
    const r = await exec("sh", ["-c", `cat ${MODELS_FILE} 2>/dev/null`]);
    return resumeTemplates(r?.stdout);
  } catch {
    return {};
  }
}

// A command other than plain claude may be a shell function or alias (ccode), which only the
// user's interactive shell defines, so it runs through `$SHELL -ic`.
export const launchLine = (env, command, args) => (command === DEFAULT_LAUNCH
  ? `${env} exec claude${args}`
  : `${env} exec "\${SHELL:-/bin/zsh}" -ic ${shellQuote(command + args)}`);

// A model is a shell command of its own, so it ignores the saved start command and always runs
// through the interactive shell that defines it.
export function launchFor(name, args, command = DEFAULT_LAUNCH) {
  if (name && typeof name === "object") {
    return `unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=${name.name} exec "\${SHELL:-/bin/zsh}" -ic ${shellQuote(`${name.command}${args}`)}`;
  }
  // The default account must run with CLAUDE_CONFIG_DIR unset, or Claude Code reads ~/.claude/.claude.json.
  const env = name === "default"
    ? "unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=default"
    : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}" CCA_ACCOUNT=${name}`;
  return launchLine(env, command, args);
}

export function resumeArgs(target, id) {
  if (target?.kind === "model") {
    return target.resume ? ` ${target.resume.split("{id}").join(id)}` : null;
  }
  return ` --resume ${id}`;
}

const display = (a) => a?.label || a?.name || "";
const codexDisplay = (a) => a?.label || (a?.name === "default" ? "System default" : (a?.name ?? ""));
export const errorText = (r, fallback) => ((r?.stderr || r?.stdout) ?? "").trim().replace(/\.$/, "") || fallback;

// A Codex agent runs under its active account's CODEX_HOME. A leading ~ stays outside the quotes
// so the shell expands it; the account name is validated, so the rest is safe to quote.
export function codexLaunch(dir, cmd) {
  const words = (Array.isArray(cmd) ? cmd : []).filter((w) => typeof w === "string" && w);
  const command = `exec ${words.map(shellQuote).join(" ")}`;
  if (!dir) return command;
  const path = String(dir);
  const target = path.startsWith("~/") ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
  return `CODEX_HOME=${target} ${command}`;
}

// One pure read of cca's porcelain, so the screen and the tests see the same lists.
export function parsePorcelain(text) {
  const out = {
    current: "default", globalDefault: "default", session: null,
    accounts: [], models: [], labels: {},
    codex: { active: "default", accounts: [] },
  };
  const byName = {};
  const codexByName = {};
  const win = (u, at) => (/^\d+(\.\d+)?$/.test(u ?? "")
    ? { used: Number(u), reset: /^\d+$/.test(at ?? "") ? Number(at) : null } : null);
  const codexAccount = (name) => {
    if (name !== "default" && !ACCOUNT_NAME.test(name ?? "")) return null;
    let c = codexByName[name];
    if (!c) {
      c = { name, email: "", usage: null, plan: null, label: null };
      codexByName[name] = c;
      out.codex.accounts.push(c);
    }
    return c;
  };
  // ~/.codex is always offered, whether or not cca reported it.
  codexAccount("default");
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    const kind = f[0];
    const name = f[1];
    if (kind === "C" && name) out.current = name;
    else if (kind === "D" && ACCOUNT_NAME.test(name ?? "")) out.globalDefault = name;
    else if (kind === "A" && ACCOUNT_NAME.test(name ?? "")) {
      if (!byName[name]) {
        byName[name] = { name, email: (f[2] ?? "").trim(), usage: null, label: null, plan: null };
        out.accounts.push(byName[name]);
      }
    } else if (kind === "M" && ACCOUNT_NAME.test(name ?? "")) {
      if (!byName[name]) {
        byName[name] = { name, kind: "model", command: (f[2] ?? "").trim(), resumable: f[3] === "1",
          label: null, usage: null, plan: null, resume: null };
        out.models.push(byName[name]);
      }
    } else if (kind === "L" && name && (f[2] ?? "").trim()) {
      out.labels[name] = f[2].trim();
    } else if (kind === "U" && byName[name]) {
      byName[name].usage = { five: win(f[2], f[3]), seven: win(f[4], f[5]), fable: win(f[6], f[7]) };
    } else if (kind === "P" && byName[name]) {
      byName[name].plan = (f[2] ?? "").trim() || null;
    } else if (kind === "S" && SESSION_ID.test(name ?? "")) {
      out.session = { id: name, cwd: (f[2] ?? "").trim() };
    } else if (kind === "Y" && name && (name === "default" || ACCOUNT_NAME.test(name))) {
      out.codex.active = name;
    } else if (kind === "X") {
      const c = codexAccount(name);
      if (c) c.email = (f[2] ?? "").trim();
    } else if (kind === "V") {
      const c = codexAccount(name);
      if (c) c.usage = { five: win(f[2], f[3]), seven: win(f[4], f[5]), fable: null };
    } else if (kind === "Q") {
      const c = codexAccount(name);
      if (c) c.plan = (f[2] ?? "").trim() || null;
    }
  }
  for (const a of out.accounts) a.label = out.labels[a.name] ?? null;
  for (const m of out.models) m.label = out.labels[m.name] ?? null;
  for (const c of out.codex.accounts) c.label = out.labels[`codex:${c.name}`] ?? null;
  return out;
}

// Herdr's JS engine ignores toLocaleDateString's weekday option and prints the whole date.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A rate-limit window past its reset time is spent: it counts as 0 % and has no reset time to show.
const liveWindow = (w) => (w?.reset && w.reset * 1000 <= Date.now() ? { used: 0, reset: null } : w);

const resetLabel = (at) => {
  const d = new Date(at * 1000);
  return d - Date.now() < 86400000
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : WEEKDAYS[d.getDay()];
};

const pctOf = (w) => (w ? Math.min(100, Math.max(0, Math.round(w.used))) : null);

// The CLI agents Herdr can start itself. Claude and Codex already own the groups above; the
// installed rest (Gemini and any other) get the "Other agents" group.
export function otherAgents(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a.key === "string" && a.installed !== false
    && a.key !== "claude" && a.key !== "codex");
}

// The two windows the Staff table budgets. An Ultra plan has no 5h window, and its weekly budget is
// the model-scoped Fable week, which the account card also showed in place of 7d.
export function staffWindows(a) {
  const fable = /ultra/i.test(a?.plan ?? "") ? a?.usage?.fable : null;
  return [["5h", liveWindow(a?.usage?.five)], ["7d", liveWindow(fable ?? a?.usage?.seven)]];
}

export function windowCell([label, w]) {
  const pct = pctOf(w);
  return { label, pct, hot: pct != null && pct >= 90, reset: w?.reset ? resetLabel(w.reset) : null };
}

// Every row the screen draws, in order, with the values the table shows. Pure, so the row layout
// can be read (and tested) without a view.
export function staffRows({ accounts = [], codex = null, globalDefault = "default", current = null, session = null, launch = DEFAULT_LAUNCH, agents = [] } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const claudeAccounts = list.filter((a) => a.kind !== "model");
  const models = list.filter((a) => a.kind === "model");
  const defaultName = claudeAccounts.some((a) => a.name === (globalDefault ?? "default")) ? (globalDefault ?? "default") : "default";
  const codexAccounts = Array.isArray(codex?.accounts) && codex.accounts.length
    ? codex.accounts
    : [{ name: "default", email: "", usage: null, plan: null, label: null }];
  const active = codex?.active === "default" || ACCOUNT_NAME.test(codex?.active ?? "") ? codex.active : "default";
  const cur = current ?? "default";
  const canResume = (a) => Boolean(session?.id) && a.name !== cur && (a.kind !== "model" || a.resumable);
  const rows = [];
  let alt = false;
  const push = (row) => {
    if (row.kind !== "group") {
      alt = !alt;
      row.alt = alt;
    }
    rows.push(row);
  };

  push({ kind: "group", id: "group-claude", title: "Claude" });
  for (const a of claudeAccounts) {
    const on = a.name === defaultName;
    push({
      kind: "account", agent: "claude", id: `claude:${a.name}`, ccaKey: a.name, name: a.name,
      display: display(a), sub: `${a.email || "not signed in"}${a.name === current ? ", this pane" : ""}`,
      contract: on ? "New sessions sign here" : "", radio: on,
      windows: staffWindows(a).map(windowCell),
      actions: [{ id: "open", label: "new pane" }, { id: "rename", label: "rename" },
        ...(canResume(a) ? [{ id: "transfer", label: "transfer this session here" }] : [])],
      focus: true, target: a,
    });
  }
  push({ kind: "add", agent: "claude", id: "add-claude", text: "+ Sign a Claude account", focus: true });

  push({ kind: "group", id: "group-codex", title: "Codex" });
  for (const c of codexAccounts) {
    const on = c.name === active;
    push({
      kind: "account", agent: "codex", id: `codex:${c.name}`, ccaKey: `codex:${c.name}`, name: c.name,
      display: codexDisplay(c), sub: c.name === "default" ? "~/.codex" : (c.email || "not signed in"),
      contract: on ? "New Codex sessions" : "", radio: on,
      windows: staffWindows(c).map(windowCell),
      actions: [{ id: "open", label: "new pane" }, { id: "rename", label: "rename" }],
      focus: true, target: c,
    });
  }
  push({ kind: "add", agent: "codex", id: "add-codex", text: "+ Sign a Codex login", focus: true });

  const others = otherAgents(agents);
  if (others.length) {
    push({ kind: "group", id: "group-agents", title: "Other agents" });
    for (const a of others) {
      push({
        kind: "agent", id: `agent:${a.key}`, name: a.name ?? a.key, display: a.name ?? a.key,
        sub: "", contract: "Launches in a new pane", radio: false, untracked: true,
        actions: [{ id: "open", label: "new pane" }],
        focus: true, target: a,
      });
    }
  }

  push({ kind: "group", id: "group-custom", title: "Custom commands" });
  for (const m of models) {
    const windows = staffWindows(m).map(windowCell);
    push({
      kind: "command", id: `model:${m.name}`, ccaKey: m.name, name: m.name, display: display(m),
      sub: m.command || "?", contract: m.resumable ? "Resumable" : "", radio: false,
      windows, untracked: windows.every((w) => w.pct == null),
      actions: [{ id: "open", label: "new pane" }, { id: "rename", label: "edit" },
        ...(canResume(m) ? [{ id: "transfer", label: "transfer this session here" }] : [])],
      focus: true, target: m,
    });
  }
  push({ kind: "add", agent: "custom", id: "add-custom", text: "+ Add custom command", focus: true });

  push({ kind: "group", id: "group-start", title: "Start command" });
  push({
    kind: "start", id: "start", value: launch ?? DEFAULT_LAUNCH,
    sub: "runs through your shell when it is not claude", focus: true,
    actions: [{ id: "edit", label: "edit" }],
  });
  return rows;
}

// The screen's keys: ↑↓ move the highlight and wrap, ↩ and Space run the row shown, o opens the
// row shown in a new pane, and Esc cancels an open rename or start-command editor.
export function staffKey(key, at, count, editing) {
  if (key === "escape") return editing ? { at, cancelEdit: true, run: false, open: false } : null;
  if (editing || !(count > 0)) return null;
  if (key === "down") return { at: (at + 1) % count, cancelEdit: false, run: false, open: false };
  if (key === "up") return { at: (at - 1 + count) % count, cancelEdit: false, run: false, open: false };
  if (key === "enter" || key === "space") return { at: Math.min(at, count - 1), cancelEdit: false, run: true, open: false };
  if (key === "o") return { at: Math.min(at, count - 1), cancelEdit: false, run: false, open: true };
  return null;
}

// Element bg() takes a solid colour, so the primary button's accent gradient is a painted layer.
function gradientFill(from, to) {
  const rect = PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%")
    .line_to("0%", "100%").close().build();
  return window.paint_path(rect, Background.linear_gradient(90, from, to)).absolute().top(0).left(0).size_full();
}

export default class FmStaff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? "screen";
    this.accounts = [{ name: "default", email: "", usage: null }];
    this.agents = Array.isArray(p.agents) ? p.agents : null;
    this.codex = null;
    this.current = "default";
    this.globalDefault = "default";
    this.session = null;
    this.readError = null;
    this.rename = null;
    this.renameError = null;
    this.addEdit = null;
    this.actionError = null;
    this.launch = null;
    this.launchEdit = null;
    this.launchError = null;
    this.keyboard = false;

    if (this.role === "menu" && p.mode === "add") {
      this.nameInput = InputState.new({ value: "" });
      this.commandInput = InputState.new({ value: "" });
      this.nameInput.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.commandInput.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      // There is no Tab handling on Input, so ↩ in the name moves on to the command while it is empty.
      this.nameInput.on("submit", (_e, cx) => {
        if (!(this.commandInput.value() ?? "").trim()) { this.commandInput.focus(); return; }
        this.addModel(cx);
      });
      this.commandInput.on("submit", (_e, cx) => this.addModel(cx));
      this.cancelHandle = cx.focus_handle();
      this.createHandle = cx.focus_handle();
      this.nameInput.focus();
      cx.timer.after(600, () => this.nameInput.focus());
      cx.timer.every(FOCUS_WATCH_MS, (cx) => this.watchFocus(cx));
      return;
    }

    this.handle = cx.focus_handle();
    this.at = 0;
    this.wasFocused = false;
    cx.timer.every(FOCUS_WATCH_MS, (cx) => this.watchFocus(cx));
    cx.timer.every(30000, (cx) => this.readAccounts(cx));
    cx.spawn(async (cx) => { this.launch = await readLaunch(); cx.notify(); });
    // The screen is focusable, so a key bound to this copy hands it the keyboard and "focus" arrives.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else if (command === "toggle") {
          if (this.handle.is_focused()) run("pane.go", { direction: "down" });
          else this.handle.focus();
        }
        cx.notify();
      }
    });
    if (!this.agents) {
      const cached = shared("new-menu.agents")?.[""];
      if (Array.isArray(cached)) this.agents = cached;
    }
    // knownAgents checks again at most once a minute; the Codex row needs the list to start one.
    if (!Array.isArray(p.agents) && this.role === "screen") this.loadAgents(cx);
    cx.timer.every(60000, (cx) => this.loadAgents(cx));
    this.readAccounts(cx);
  }

  loadAgents(cx) {
    cx.spawn(async (cx) => {
      let list = null;
      try { list = await knownAgents(); } catch {}
      if (!Array.isArray(list)) list = shared("new-menu.agents")?.[""];
      if (!Array.isArray(list)) return;
      this.agents = list;
      cx.notify();
    });
  }

  focusedPid() {
    const f = focused();
    const a = agents().find((x) => x.focused || (f && (f.terminal === x.address || f.agent === x.address)));
    if (!a || a.address.includes("/")) return null;
    const t = terminals().find((x) => x.address === a.address);
    const claude = [t?.program?.key, t?.foreground?.name].some((n) => String(n ?? "").toLowerCase().includes("claude"));
    return claude ? t?.foreground?.pid ?? null : null;
  }

  readAccounts(cx, pid = this.focusedPid()) {
    if (this.readingAccounts) return;
    this.focusKey = pid == null ? "" : String(pid);
    this.readingAccounts = true;
    cx.spawn(async (cx) => {
      let r = null;
      try {
        r = await exec("sh", this.focusKey ? [cca(), "--porcelain", this.focusKey] : [cca(), "--porcelain"]);
      } catch {}
      const p = parsePorcelain(r?.stdout ?? "");
      const accounts = p.accounts;
      const models = p.models;
      const resumes = await modelResumes();
      for (const m of models) m.resume = resumes[m.name] ?? null;
      accounts.push(...models);
      this.readingAccounts = false;
      if (accounts.length) {
        this.readError = null;
        this.accounts = accounts;
        this.current = p.current;
        this.globalDefault = p.globalDefault;
        this.session = p.session?.cwd ? p.session : null;
        this.codex = p.codex;
      } else if (!r || r.code === 127) {
        this.readError = `cca not found: ${cca()} — reinstall the staff mod`;
      }
      cx.notify();
      // A focus change that landed during the read is picked up here, not on the 30 s timer.
      const now = this.focusedPid();
      if ((now == null ? "" : String(now)) !== this.focusKey) this.readAccounts(cx, now);
    });
  }

  closeSelf() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // Opens the chosen account's Claude Code in a pane beside the focused one; running agents keep their own account.
  openAgent(name) {
    if (!ACCOUNT_NAME.test(name)) return;
    this.withLaunch((command) => this.startPane(["sh", "-lc", launchFor(name, "", command)]));
  }

  // Closing a popup ends that copy of the mod, so a split asked for after the close never runs:
  // the pane is asked for first and the popup closes after it.
  startPane(argv) {
    run("pane.split", { direction: "right", argv });
    this.closeSelf();
  }

  withLaunch(start) {
    if (this.launch) start(this.launch);
    else readLaunch().then(start);
  }

  openModel(model) {
    if (!ACCOUNT_NAME.test(model?.name ?? "")) return;
    run("pane.split", { direction: "right", argv: ["sh", "-lc", launchFor(model, "")] });
  }

  // An installed agent launches with the argv Herdr's own new menu would use.
  openOtherAgent(a) {
    const argv = Array.isArray(a?.run) ? a.run.filter((word) => typeof word === "string" && word) : [];
    if (!argv.length) return;
    this.startPane(argv);
  }

  // The Claude account new sessions open as: the global default when it names one, else default.
  claudeDefault() {
    const name = this.globalDefault ?? "default";
    const list = this.accounts ?? [];
    return list.some((a) => a.kind !== "model" && a.name === name) ? name : "default";
  }

  codexState() {
    const c = this.codex;
    const accounts = Array.isArray(c?.accounts) && c.accounts.length
      ? c.accounts
      : [{ name: "default", email: "", usage: null, plan: null, label: null }];
    const active = c?.active === "default" || ACCOUNT_NAME.test(c?.active ?? "") ? c.active : "default";
    return { active, accounts };
  }

  editing() {
    return Boolean(this.rename || this.addEdit || this.launchEdit);
  }

  // A Codex pane starts under one account's CODEX_HOME; only the active one is used from the row.
  openCodex(active = this.codexState().active) {
    const agent = (this.agents ?? []).find((a) => a?.key === "codex" && a.installed !== false);
    if (!agent || !Array.isArray(agent.run)) return;
    const dir = active === "default" ? null : `~/.codex-accounts/${active}`;
    this.closeSelf();
    run("pane.split", { direction: "right", argv: ["sh", "-lc", codexLaunch(dir, agent.run)] });
  }

  startAdd(kind, cx) {
    if (kind === "custom") {
      openOverlay({ mod: "fm-staff", kind: "popup", width: 340, height: 340, props: { role: "menu", mode: "add" } });
      return;
    }
    this.rename = null;
    this.renameError = null;
    this.launchEdit = null;
    this.launchError = null;
    this.actionError = null;
    const input = InputState.new({ value: "" });
    input.on("submit", (_e, cx) => this.submitAdd(cx));
    this.addEdit = { kind, input };
    input.focus();
    cx.timer.after(300, () => { if (this.addEdit?.input === input) input.focus(); });
    cx.notify();
  }

  submitAdd(cx) {
    const edit = this.addEdit;
    if (!edit || this.adding) return;
    const name = (edit.input.value() ?? "").trim();
    const base = edit.kind === "codex" ? "~/.codex" : "~/.claude";
    if (!ACCOUNT_NAME.test(name)) { this.actionError = "Use letters, digits, - or _ only"; cx.notify(); return; }
    if (name === "default") { this.actionError = `default is the ${base} account — pick another name`; cx.notify(); return; }
    if (RESERVED.has(name) || name.startsWith("-")) { this.actionError = `${name} is a cca command — pick another name`; cx.notify(); return; }
    this.adding = true;
    this.actionError = null;
    cx.notify();
    if (edit.kind === "codex") this.createCodex(name, cx);
    else this.createClaude(name, cx);
  }

  createClaude(name, cx) {
    cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "--porcelain-add", name]); } catch {}
      this.adding = false;
      if (!r || r.code !== 0) {
        this.actionError = errorText(r, "Could not create the account folder — check ~/.claude-accounts is writable");
        cx.notify();
        return;
      }
      this.addEdit = null;
      this.openAgent(name);
      this.readAccounts(cx);
    });
  }

  createCodex(name, cx) {
    cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "--porcelain-add-codex", name]); } catch {}
      this.adding = false;
      if (!r || r.code !== 0) {
        this.actionError = errorText(r, "Could not create the account folder — check ~/.codex-accounts is writable");
        cx.notify();
        return;
      }
      const dir = (r.stdout ?? "").trim();
      this.addEdit = null;
      this.closeSelf();
      const target = dir ? shellQuote(dir) : `"$HOME"/.codex-accounts/${name}`;
      run("pane.split", { direction: "right",
        argv: ["sh", "-lc", `CODEX_HOME=${target} codex login; exec $SHELL -l`] });
      this.readAccounts(cx);
    });
  }

  addModel(cx) {
    if (this.addingModel) return;
    const label = (this.nameInput?.value() ?? "").trim();
    const command = (this.commandInput?.value() ?? "").trim();
    if (/[\t\r\n]/.test(command)) { this.error = "The start command must be one line"; cx.notify(); return; }
    this.addingModel = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "--porcelain-add-model", label, command]); } catch {}
      this.addingModel = false;
      if (!r || r.code !== 0) {
        this.error = errorText(r, "Could not add the model — check the models file is writable");
        cx.notify();
        return;
      }
      this.closeSelf();
      cx.notify();
    });
  }

  // Makes the account new sessions start under; the screen stays so the radio follows.
  useAccount(name, cx) {
    if (!ACCOUNT_NAME.test(name) || this.usingAccount) return;
    this.usingAccount = true;
    this.actionError = null;
    cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "use", name]); } catch {}
      this.usingAccount = false;
      if (!r || r.code !== 0) {
        this.actionError = errorText(r, "Could not change the default account — check cca and retry");
        cx.notify();
        return;
      }
      this.readAccounts(cx);
      cx.notify();
    });
  }

  // The Codex half of useAccount; the screen stays so the radio follows.
  useCodex(name, cx) {
    if (!ACCOUNT_NAME.test(name) || this.usingCodex) return;
    this.usingCodex = true;
    this.actionError = null;
    cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "codex", "use", name]); } catch {}
      this.usingCodex = false;
      if (!r || r.code !== 0) {
        this.actionError = errorText(r, "Could not change the Codex account — check cca and retry");
        cx.notify();
        return;
      }
      this.readAccounts(cx);
      cx.notify();
    });
  }

  startRename(a, cx, key = a.name) {
    this.actionError = null;
    this.launchEdit = null;
    this.launchError = null;
    this.addEdit = null;
    this.renameError = null;
    const input = InputState.new({ value: a.label || a.name || "" });
    input.on("submit", (_e, cx) => this.saveRename(cx));
    this.rename = { key, name: a.name, input };
    input.focus();
    cx.timer.after(300, () => { if (this.rename?.input === input) input.focus(); });
    cx.notify();
  }

  saveRename(cx) {
    const r = this.rename;
    if (!r || this.savingRename) return;
    const value = (r.input.value() ?? "").trim();
    this.savingRename = true;
    this.renameError = null;
    cx.spawn(async (cx) => {
      let res = null;
      try { res = await exec("sh", [cca(), "--porcelain-rename", r.key, value]); } catch {}
      this.savingRename = false;
      if (!res || res.code !== 0) {
        this.renameError = errorText(res, "Could not rename the account — try another name");
        cx.notify();
        return;
      }
      this.rename = null;
      this.readAccounts(cx);
      cx.notify();
    });
  }

  startLaunchEdit(cx) {
    this.rename = null;
    this.renameError = null;
    this.addEdit = null;
    this.launchError = null;
    const input = InputState.new({ value: this.launch ?? DEFAULT_LAUNCH });
    input.on("submit", (_e, cx) => this.saveLaunch(cx));
    this.launchEdit = { input };
    input.focus();
    cx.timer.after(300, () => { if (this.launchEdit?.input === input) input.focus(); });
    cx.notify();
  }

  saveLaunch(cx) {
    const edit = this.launchEdit;
    if (!edit || this.savingLaunch) return;
    const value = (edit.input.value() ?? "").trim() || DEFAULT_LAUNCH;
    if (/[\n\r]/.test(value)) { this.launchError = "One line only — the command runs in a shell"; cx.notify(); return; }
    this.savingLaunch = true;
    cx.spawn(async (cx) => {
      let res = null;
      try {
        res = await exec("sh", ["-c", `f=${LAUNCH_FILE}; mkdir -p "$(dirname "$f")" && printf '%s\\n' "$1" > "$f"`, "x", value]);
      } catch {}
      this.savingLaunch = false;
      if (!res || res.code !== 0) {
        this.launchError = errorText(res, "Could not save the command — check the state folder is writable");
        cx.notify();
        return;
      }
      this.launch = value;
      this.launchEdit = null;
      this.handle.focus();
      cx.notify();
    });
  }

  // Resumes the focused agent's session under another account or model in a new pane; the old one
  // keeps running.
  continueAs(target, session) {
    const model = target && typeof target === "object" && target.kind === "model" ? target : null;
    const name = target && typeof target === "object" ? target.name : target;
    if (!ACCOUNT_NAME.test(name ?? "") || !SESSION_ID.test(session?.id ?? "") || !session?.cwd) return;
    const args = resumeArgs(model, session.id);
    if (!args) return;
    // pane.split takes no folder, so the shell changes into the session's cwd first.
    const cwd = `'${session.cwd.replace(/'/g, "'\\''")}'`;
    if (model) {
      this.startPane(["sh", "-lc", `cd ${cwd} && ${launchFor(model, args)}`]);
      return;
    }
    this.withLaunch((command) => this.startPane(["sh", "-lc", `cd ${cwd} && ${launchFor(name, args, command)}`]));
  }

  // readAccounts keeps the focused pane's pid in this.focusKey, so the ring's key has its own name.
  ringKey() {
    return `${this.keyboard ? 1 : 0}|${[this.handle, this.cancelHandle, this.createHandle]
      .map((handle) => (handle?.is_focused?.() ? 1 : 0)).join("")}`;
  }

  // A ring comes from is_focused(), and the shell redraws only on notify or reload; only the
  // keyboard draws it, since a click focuses the screen too.
  watchFocus(cx) {
    const focusedNow = Boolean(this.handle?.is_focused?.());
    // A popup over the screen hands the keyboard back on close; its writes land while it is gone.
    if (focusedNow && !this.wasFocused) this.readAccounts(cx);
    this.wasFocused = focusedNow;
    const key = this.ringKey();
    if (key === this.drawnFocus) return;
    this.drawnFocus = key;
    cx.notify();
  }

  focusedAt(index) {
    return this.keyboard && index === this.at && Boolean(this.handle?.is_focused?.());
  }

  handlers(row) {
    if (row.kind === "account" && row.agent === "claude") {
      return { run: (cx) => this.useAccount(row.name, cx), open: () => this.openAgent(row.name) };
    }
    if (row.kind === "account" && row.agent === "codex") {
      return { run: (cx) => this.useCodex(row.name, cx), open: () => this.openCodex(row.name) };
    }
    if (row.kind === "command") {
      const open = () => this.openModel(row.target);
      return { run: open, open };
    }
    if (row.kind === "agent") {
      const open = () => this.openOtherAgent(row.target);
      return { run: open, open };
    }
    if (row.kind === "add") return { run: (cx) => this.startAdd(row.agent, cx), open: null };
    if (row.kind === "start") return { run: (cx) => this.startLaunchEdit(cx), open: null };
    return { run: null, open: null };
  }

  runAction(row, id, cx) {
    if (id === "open") {
      if (row.kind === "command") this.openModel(row.target);
      else if (row.kind === "agent") this.openOtherAgent(row.target);
      else if (row.agent === "codex") this.openCodex(row.name);
      else this.openAgent(row.name);
      return;
    }
    if (id === "rename") { this.startRename(row.target, cx, row.ccaKey); return; }
    if (id === "transfer") { this.continueAs(row.target, this.session); return; }
    if (id === "edit") { this.startLaunchEdit(cx); }
  }

  hint() {
    if (this.readError) return { text: this.readError, error: true };
    if (this.actionError) return { text: this.actionError, error: true };
    if (this.renameError) return { text: this.renameError, error: true };
    if (this.launchError) return { text: this.launchError, error: true };
    if (this.rename) return { text: "↩ save · esc cancel" };
    if (this.addEdit) return { text: "↩ create · esc cancel" };
    if (this.launchEdit) return { text: "↩ save · esc cancel · empty = claude" };
    return null;
  }

  radio(on) {
    return h_flex().size(14).flex_none().rounded(7).border(2).border_color(on ? C.accent : C.ink3)
      .items_center().justify_center()
      .when(on, (el) => el.child(div().size(6).rounded(3).bg(C.accent)));
  }

  head() {
    return h_flex().flex_none().w_full().items_center().gap(10).pt(14).px(18).pb(10)
      .child(div().text_size(FS.h).font_family(FONT.display).font_weight(700).text_color(C.ink)
        .child("BACKROOM STAFF"))
      .child(div().text_size(FS.sm).font_family(FONT.body).text_color(C.ink3)
        .child("agents, logins and their wage budgets"))
      .child(div().flex_1())
      .child(div().text_size(FS.sm).font_family(FONT.body).text_color(C.ink3)
        .child("↑↓ move, ↩ start, o debut in a new pane"));
  }

  tableHead() {
    const th = (text, width) => div().when(Boolean(width), (el) => el.w(width)).when(!width, (el) => el.flex_1().min_w(0))
      .truncate().text_size(FS.sm).font_family(FONT.body).font_weight(600).text_color(C.ink3).child(text);
    return h_flex().flex_none().w_full().items_center().px(12).pb(4)
      .child(th("Starts", 44))
      .child(th("Name"))
      .child(th("Contract", 200))
      .child(th("5h wage budget", 220))
      .child(th("Week wage budget", 220))
      .child(th("", 270));
  }

  usageCell(w) {
    return v_flex().w(220).flex_none().gap(2)
      .child(h_flex().items_center().gap(8)
        .child(div().w(110).flex_none().h(6).rounded(3).bg(C.barTrack).overflow_hidden()
          .child(div().h_full().w(`${w.pct ?? 0}%`).rounded(3).bg(w.hot ? C.barHot : C.bar)))
        .child(div().w(40).flex_none().flex().justify_end().text_size(FS.sm).font_family(FONT.body)
          .font_weight(600).text_color(w.hot ? C.needs : C.ink).child(w.pct == null ? "–" : `${w.pct}%`)))
      .child(div().h(14).text_size(FS.xs).font_family(FONT.body).text_color(C.ink3)
        .child(w.reset ? `resets ${w.reset}` : " "));
  }

  actionLinks(row) {
    return h_flex().w(270).flex_none().items_center().gap(10)
      .children(row.actions.map((a) => h_flex().id(`${row.id}-${a.id}`).flex_none().cursor_pointer()
        .text_size(FS.sm).font_family(FONT.body).font_weight(600).text_color(C.link).underline()
        .hover((h) => h.text_color(C.ink))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (!this.editing()) this.runAction(row, a.id, cx);
        })
        .child(a.label)));
  }

  rowFrame(row, sel) {
    return h_flex().id(row.id).relative().w_full().flex_none().items_center().px(12)
      .when(row.alt, (el) => el.bg(C.rowAlt))
      .when(sel, (el) => el.bg(C.panel3))
      .when(!sel, (el) => el.hover((h) => h.bg(C.veil1)))
      .when(sel, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(3).bg(C.focusKb)));
  }

  groupRow(row) {
    return h_flex().id(row.id).w_full().flex_none().items_center().pt(16).pb(6).px(12)
      .child(div().text_size(FS.base).font_family(FONT.body).font_weight(700).text_color(C.ink3).child(row.title));
  }

  accountRow(row, sel, cx) {
    const renaming = Boolean(this.rename) && this.rename.key === row.ccaKey;
    const handlers = this.handlers(row);
    return this.rowFrame(row, sel).h(52).cursor_pointer()
      .on_click((_e, cx) => {
        if (!this.editing() && handlers.run) handlers.run(cx);
      })
      .child(div().w(44).flex_none().when(row.kind === "account", (el) => el.child(this.radio(row.radio))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .when(renaming, (el) => el.child(Input.new(this.rename.input).h(26).w_full().px(8).rounded(R.r2)
          .border(1).border_color(C.focusKb).bg(C.panel2).text_size(FS.base).font_family(FONT.body).text_color(C.ink)))
        .when(!renaming, (el) => el
          .child(div().truncate().text_size(FS.md).font_family(FONT.body).font_weight(700)
            .text_color(sel ? C.focusKb : C.ink).child(row.display))
          .child(div().truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink3).child(row.sub))))
      .child(div().w(200).flex_none().truncate().text_size(FS.base).font_family(FONT.body).text_color(C.ink2)
        .child(row.contract))
      .children(row.untracked
        ? [div().w(440).flex_none().text_size(FS.sm).font_family(FONT.body).text_color(C.ink3).child("usage not tracked")]
        : row.windows.map((w) => this.usageCell(w)))
      .child(this.actionLinks(row));
  }

  addRow(row, sel, cx) {
    const editing = this.addEdit?.kind === row.agent;
    return this.rowFrame(row, sel).h(38)
      .when(!editing, (el) => el.cursor_pointer().on_click((_e, cx) => {
        if (!this.editing()) this.startAdd(row.agent, cx);
      }))
      .child(div().w(44).flex_none())
      .when(editing, (el) => el.child(Input.new(this.addEdit.input).h(26).flex_1().min_w(0).px(8).rounded(R.r2)
        .border(1).border_color(C.focusKb).bg(C.panel2).text_size(FS.sm).font_family(FONT.body).text_color(C.ink)))
      .when(!editing, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(FS.sm).font_family(FONT.body)
        .font_weight(600).text_color(sel ? C.focusKb : C.ink2).child(row.text)));
  }

  startRow(row, sel, cx) {
    const editing = Boolean(this.launchEdit);
    const handlers = this.handlers(row);
    return this.rowFrame(row, sel).h(52).cursor_pointer()
      .on_click((_e, cx) => {
        if (!this.editing() && handlers.run) handlers.run(cx);
      })
      .child(div().w(44).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(2)
        .when(editing, (el) => el.child(Input.new(this.launchEdit.input).h(26).w_full().px(8).rounded(R.r2)
          .border(1).border_color(C.focusKb).bg(C.panel2).text_size(FS.base).font_family(FONT.mono).text_color(C.ink)))
        .when(!editing, (el) => el
          .child(div().truncate().text_size(FS.base).font_family(FONT.mono).font_weight(600)
            .text_color(sel ? C.focusKb : C.ink).child(row.value))
          .child(div().truncate().text_size(FS.sm).font_family(FONT.body).text_color(C.ink3).child(row.sub))))
      .child(div().w(200).flex_none())
      .child(div().w(220).flex_none())
      .child(div().w(220).flex_none())
      .child(this.actionLinks(row));
  }

  screen(cx) {
    this.drawnFocus = this.ringKey();
    const rows = staffRows({
      accounts: this.accounts, codex: this.codexState(), globalDefault: this.globalDefault,
      current: this.current, session: this.session, launch: this.launch, agents: this.agents,
    });
    const focusRows = [];
    const indexOf = new Map();
    for (const row of rows) {
      if (!row.focus) continue;
      indexOf.set(row.id, focusRows.length);
      focusRows.push(this.handlers(row));
    }
    if (this.at >= focusRows.length) this.at = Math.max(0, focusRows.length - 1);
    const hint = this.hint();
    return v_flex().id("staff-screen").size_full().min_h(0)
      .track_focus(this.handle).tab_index(0)
      .on_mouse_down("left", (_e, cx) => { if (this.keyboard) { this.keyboard = false; cx.notify(); } })
      .on_key_down((event, cx) => {
        const next = staffKey(event.key, this.at, focusRows.length, this.editing());
        if (!next) {
          // The live terminal sits below the screens; Esc hands the keyboard back to it.
          if (event.key === "escape" && !this.editing()) run("pane.go", { direction: "down" });
          return;
        }
        cx.stop_propagation();
        if (next.cancelEdit) {
          this.rename = null;
          this.renameError = null;
          this.addEdit = null;
          this.launchEdit = null;
          this.launchError = null;
          this.actionError = null;
          this.handle.focus();
          cx.notify();
          return;
        }
        this.keyboard = true;
        this.at = next.at;
        cx.notify();
        if (next.run) focusRows[this.at]?.run(cx);
        else if (next.open) focusRows[this.at]?.open?.(cx);
      })
      .child(this.head())
      .child(this.tableHead())
      .child(div().flex_1().min_h(0).w_full().overflow_y_scroll()
        .children(rows.map((row) => {
          if (row.kind === "group") return this.groupRow(row);
          const index = indexOf.get(row.id);
          const sel = index != null && this.focusedAt(index);
          if (row.kind === "add") return this.addRow(row, sel, cx);
          if (row.kind === "start") return this.startRow(row, sel, cx);
          return this.accountRow(row, sel, cx);
        })))
      .child(div().h(24).flex_none().w_full().px(18).flex().items_center()
        .text_size(FS.xs).font_family(FONT.body).text_color(hint?.error ? C.needs : C.ink3)
        .child(hint?.text ?? ""));
  }

  addAgentView(cx) {
    const button = (id, label, primary, handle, action) => h_flex().id(id).relative().overflow_hidden()
      .h(36).px(14).items_center().justify_center().rounded(R.r2).border(1)
      .border_color(primary ? C.accent : C.line).bg(primary ? C.accent : C.panel2)
      .text_size(FS.base).font_family(FONT.body).font_weight(600).cursor_pointer()
      .text_color(primary ? C.accentInk : C.ink)
      .when(Boolean(handle), (el) => el.track_focus(handle).tab_index(0))
      .when(Boolean(this.keyboard && handle?.is_focused?.()), (el) => el.border(2).border_color(C.focusKb))
      .role("button").accessibility_label(label)
      .when(primary, (el) => el.hover((h) => h.opacity(0.95)).child(gradientFill(C.accent2, C.accent)))
      .when(!primary, (el) => el.hover((h) => h.bg(C.panel3)))
      .on_key_down((event, cx) => {
        if (event.key !== "enter" && event.key !== "space") return;
        this.keyboard = true;
        cx.stop_propagation();
        action(cx);
        cx.notify();
      })
      .on_click((_e, cx) => action(cx))
      .child(label);
    const label = (text) => div().text_size(FS.sm).font_family(FONT.body).font_weight(600).text_color(C.ink3).child(text);
    const field = (state, mono = false) => Input.new(state).h(34).px(10).rounded(R.r2).border(1)
      .border_color(C.line).bg(C.panel2).text_size(mono ? FS.sm : FS.base)
      .font_family(mono ? FONT.mono : FONT.body).text_color(C.ink);
    return v_flex().id("staff-add").size_full().p(14).gap(8).bg(C.panelSolid)
      .on_mouse_down("left", (_e, cx) => { this.keyboard = false; cx.notify(); })
      .child(div().text_size(FS.lg).font_family(FONT.display).font_weight(700).text_color(C.ink)
        .child("Add custom command"))
      .child(label("Name"))
      .child(field(this.nameInput))
      .child(label("Start command"))
      .child(field(this.commandInput, true))
      .when(Boolean(this.error), (el) => el.child(div().text_size(FS.xs).font_family(FONT.body)
        .text_color(C.needs).child(this.error)))
      .child(div().text_size(FS.xs).font_family(FONT.body).text_color(C.ink3)
        .child("runs in your shell, so functions like claude-gpt work · ↩ add · esc cancel"))
      .child(h_flex().justify_end().gap(8)
        .child(button("staff-cancel", "Cancel", false, this.cancelHandle, (cx) => {
          this.closeSelf();
          cx.notify();
        }))
        .child(button("staff-create", this.addingModel ? "Adding…" : "Add", true, this.createHandle, (cx) => this.addModel(cx))));
  }

  render(cx) {
    this.drawnFocus = this.ringKey();
    if (this.role === "menu") return this.addAgentView(cx);
    return this.screen(cx);
  }
}
