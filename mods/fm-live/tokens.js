// FM27 design tokens shared by every fm-* mod. Source of truth: design/tokens.css.
// tools/install.sh copies this file into each mod folder (mods cannot read each other).
// Colours are #rrggbb or #rrggbbaa so they can go straight into gpui-kit styles.

export const C = {
  // ground
  bg: "#0e0918",
  bg2: "#130d20",
  panel: "#181026f0",
  panelSolid: "#181026",
  panel2: "#1f1631",
  panel3: "#281d3d",
  line: "#2f2447",
  line2: "#3d3059",
  lineSoft: "#ffffff0b",
  rowAlt: "#ffffff06",
  hi: "#ffffff0d",
  // chrome
  nav: "#1b2875",
  nav2: "#222f88",
  nav3: "#3550c8",
  navInk: "#e9ecff",
  sub: "#120c22",
  // ink
  ink: "#f2eff9",
  ink2: "#bdb4d1",
  ink3: "#82789a",
  ink4: "#5d5474",
  // accent (the one Continue / primary action colour)
  accent: "#ff2e7e",
  accent2: "#e0156c",
  accentInk: "#fbfaff",
  link: "#ff5aa8",
  // session states
  needs: "#ff4d5e",
  needsFill: "#d42035",
  stall: "#c9a25a",
  working: "#36d26b",
  workingBand: "#0f4a2c",
  workingBand2: "#0a3720",
  needsBand: "#7a1424",
  needsBand2: "#5a0f1d",
  done: "#9a86d6",
  doneBand: "#2c1a4c",
  doneBand2: "#21133a",
  // selection: keyboard cursor = lit band + 3px left bar in focusKb, never a ring
  focusKb: "#f6d84a",
  focusMouse: "#6f8cff",
  // bars
  barTrack: "#2c2340",
  bar: "#ff3d8f",
  barHot: "#ff4d5e",
  // veils and shades over coloured chrome
  veil1: "#ffffff12",
  veil2: "#ffffff1a",
  veil3: "#ffffff26",
  veilInk: "#ffffffbf",
  shade1: "#0000002e",
  shade2: "#00000038",
  shade3: "#00000047",
  paper: "#fbfaff",
  select: "#8b3ff2",
  // agent "nationality" flags
  natCld: "#e07a52",
  natCdx: "#3a8dde",
  natGem: "#5b8cff",
  // terminal
  termBg: "#0b0714",
  termInk: "#d9d3ea",
};

export const FONT = {
  body: "Barlow",
  display: "Barlow Condensed",
  mono: "JetBrains Mono",
};

// type sizes (px at zoom 1)
export const FS = { xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 18, h: 20, h2: 24, h3: 30, hero: 38 };

// radius
export const R = { r1: 4, r2: 6, r3: 10, pill: 999 };

// motion (ms); every control eases with the same curve
export const DUR = { micro: 120, short: 180, panel: 220 };

// state -> colour / label (UI fixed strings are English football terms)
export const STATE = {
  needs: { color: C.needs, fill: C.needsFill, label: "Touchline" },
  stall: { color: C.stall, fill: C.stall, label: "Stoppage" },
  working: { color: C.working, fill: C.workingBand, label: "In possession" },
  done: { color: C.done, fill: C.panel3, label: "Full time" },
};

// group ids (same ids chiikawa-cards used internally) -> football group titles
export const GROUP = {
  attention: { title: "Touchline", hint: "waiting on your instructions, longest first", color: C.needs },
  working: { title: "In possession", hint: "oldest first", color: C.working },
  done: { title: "Full time", hint: "newest first", color: C.done },
};

// agent kind -> nationality code and flag colours
export const NAT = {
  claude: { code: "CLD", name: "Claude", color: C.natCld },
  codex: { code: "CDX", name: "Codex", color: C.natCdx },
  gemini: { code: "GEM", name: "Gemini", color: C.natGem },
};

// screens shown by the top menu; ids are the child ids of the "screens" stack in layouts/fm27.json
export const SCREENS = [
  { id: "squad", title: "Squad" },
  { id: "inbox", title: "Inbox" },
  { id: "staff", title: "Staff" },
  { id: "club", title: "Club" },
];
export const SCREEN_STACK = "screens";

// shared() keys between fm-* mods
export const KEY = {
  squad: "fm.squad", // published by fm-squad (role squad): summary for chrome/overview/inbox/club
  notice: "fm.notice", // {tone, text, action} published by fm-squad, shown by fm-chrome sub bar
  noticeAct: "fm.notice-act", // {token, act} written by fm-chrome, polled by fm-squad
  cmd: "fm.cmd", // {token, name, args} one-shot commands from chrome/overview/inbox to fm-squad
  screen: "fm.screen", // current screen id, written by whoever switches it
  sel: "fm.sel", // selected session key, written by fm-squad
};
