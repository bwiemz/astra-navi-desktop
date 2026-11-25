/**
 * How the station's page looks: the one stylesheet of `stationPage.ts`, carried in the
 * page itself. Nothing is fetched from anywhere.
 */

// Drawn like the rest of her: comic panels on paper, one ink colour for every outline,
// hard offset shadows. The colours mirror the settings page. The one loud thing is her
// mood: it colours the band under the header, the mark beside her name and the shadow of
// her name plate. Everything else stays quiet so that it can be.
export const STATION_STYLE = String.raw`
:root {
  --sky: #59c8f5;
  --paper: #fffdf6;
  --ink: #1b1f3b;
  --blush: #ff6fa3;
  --lemon: #ffe27a;
  --haze: #c9cbe0;
  --page: var(--sky);
  --card: var(--paper);
  --text: var(--ink);
  --line: var(--ink);
  --soft: #4d5279;
  --top: var(--ink);
  --top-text: var(--paper);
  --dots: rgb(27 31 59 / 9%);
  --mine: var(--ink);
  --mine-text: var(--paper);
  --mood: var(--paper);
  --outline: 2.5px solid var(--line);
  --drop: 4px 4px 0 var(--line);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  color-scheme: light dark;
  font-family: ui-rounded, "SF Pro Rounded", "M PLUS Rounded 1c", "Hiragino Maru Gothic ProN",
    "Nunito", "One UI Sans", "Noto Sans CJK JP", "Noto Sans", system-ui, sans-serif;
  font-size: 100%;
  line-height: 1.45;
  color: var(--text);
  -webkit-text-size-adjust: 100%;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #12152b;
    --card: #252a4d;
    --text: #f4f1e4;
    --line: #f4f1e4;
    --soft: #b4b8d6;
    --top: #090b1a;
    --dots: rgb(244 241 228 / 6%);
    --mine: var(--lemon);
    --mine-text: #1b1f3b;
  }
}
body[data-mood="happy"], body[data-mood="excited"] { --mood: var(--lemon); }
body[data-mood="thinking"] { --mood: var(--sky); }
body[data-mood="smug"], body[data-mood="surprised"] { --mood: var(--blush); }
body[data-mood="worried"], body[data-mood="sad"] { --mood: var(--haze); }

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
  margin: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100dvh;
  background:
    radial-gradient(circle, var(--dots) 1px, transparent 1.4px) 0 0 / 11px 11px,
    var(--page);
  overscroll-behavior: none;
}
h1, h2, h3, p, ol, ul { margin: 0; }
button {
  min-height: 48px;
  padding: 10px 18px;
  font: inherit;
  font-weight: 800;
  color: #1b1f3b;
  background: var(--blush);
  border: var(--outline);
  border-radius: 0;
  box-shadow: 3px 3px 0 var(--line);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--line); }
button:disabled { opacity: 0.55; cursor: default; }
button.quiet { color: var(--text); background: var(--card); }
:focus-visible { outline: 3px solid var(--blush); outline-offset: 2px; }
input, textarea {
  width: 100%;
  padding: 11px 12px;
  font: inherit;
  font-size: 1.0625rem;
  color: var(--text);
  background: var(--card);
  border: var(--outline);
  border-radius: 0;
}
input:focus, textarea:focus { outline: none; box-shadow: 3px 3px 0 var(--blush); }
.notice { font-size: 0.72rem; line-height: 1.35; color: var(--soft); }

/* ---------- the header: an ink band that her mood underlines ---------- */
.top {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: 12px;
  padding: 10px 12px 8px 14px;
  padding-top: max(10px, env(safe-area-inset-top));
  color: var(--top-text);
  background: var(--top);
  border-bottom: 5px solid var(--mood);
  transition: border-color 0.35s ease;
}
.mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  background: var(--mood);
  border: 2.5px solid var(--top-text);
  border-radius: 13px;
  transition: background-color 0.35s ease;
}
.mark svg {
  width: 30px;
  height: 30px;
  overflow: visible;
  transition: transform 0.4s cubic-bezier(0.3, 1.5, 0.5, 1);
}
.mark .glint { opacity: 0; transition: opacity 0.3s ease; }
body[data-mood="happy"] .mark svg { transform: rotate(8deg) scale(1.06); }
body[data-mood="excited"] .mark svg { transform: rotate(18deg) scale(1.16); }
body[data-mood="happy"] .mark .glint, body[data-mood="excited"] .mark .glint { opacity: 1; }
body[data-mood="surprised"] .mark svg { transform: scale(1.3); }
body[data-mood="smug"] .mark svg { transform: rotate(24deg) translateY(-1px); }
body[data-mood="worried"] .mark svg { transform: rotate(-14deg) scale(0.82); }
body[data-mood="sad"] .mark svg { transform: rotate(-6deg) translateY(4px) scale(0.76); }
body[data-mood="thinking"] .mark svg { animation: turn 5s linear infinite; }
.mark.pop { animation: pop 0.42s cubic-bezier(0.3, 1.6, 0.5, 1); }
@keyframes pop { 40% { transform: scale(1.2) rotate(-6deg); } }
@keyframes turn { to { transform: rotate(360deg); } }
.name { min-width: 0; }
.plate {
  display: inline-block;
  padding: 1px 12px 3px;
  font-size: 1.3rem;
  font-weight: 800;
  line-height: 1.2;
  color: #1b1f3b;
  background: var(--lemon);
  border: 2.5px solid var(--top-text);
  box-shadow: 3px 3px 0 var(--mood);
  transform: rotate(-1.5deg);
  transition: box-shadow 0.35s ease;
}
.fan { margin-top: 5px; font-size: 0.7rem; font-weight: 700; opacity: 0.8; white-space: nowrap; }
.state { display: flex; flex-direction: column; align-items: flex-end; }
.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  font-weight: 800;
  white-space: nowrap;
}
.link::before {
  content: "";
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--top-text);
  background: transparent;
}
.link[data-state="on"]::before { background: var(--lemon); }
.link[data-state="lost"]::before { background: var(--blush); }
.mood {
  display: inline-block;
  margin-top: 5px;
  padding: 0 8px 1px;
  font-size: 0.7rem;
  font-weight: 800;
  color: #1b1f3b;
  background: var(--mood);
  border-radius: 999px;
  transition: background-color 0.35s ease;
}
.menu {
  width: 48px;
  min-height: 48px;
  padding: 0;
  display: grid;
  place-content: center;
  gap: 5px;
  background: transparent;
  border: 2.5px solid var(--top-text);
  box-shadow: none;
}
.menu:active { transform: none; box-shadow: none; background: rgb(255 255 255 / 14%); }
.menu span { display: block; width: 20px; height: 3px; background: var(--top-text); }

main { min-height: 0; }

/* ---------- pairing ---------- */
.pairing { overflow-y: auto; padding: 18px 16px calc(24px + var(--safe-bottom)); }
.panel {
  max-width: 26rem;
  margin: 0 auto;
  padding: 18px 18px 20px;
  background: var(--card);
  border: var(--outline);
  box-shadow: var(--drop);
}
.panel h2 { font-size: 1.4rem; font-weight: 800; line-height: 1.2; }
.steps-list { margin: 10px 0 4px; padding-left: 1.3em; }
.steps-list li { margin: 4px 0; }
.steps-list li::marker { font-weight: 800; }
label { display: block; margin: 16px 0 5px; font-weight: 800; }
#code {
  font-size: 1.9rem;
  font-weight: 800;
  letter-spacing: 0.22em;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.panel button { margin-top: 18px; width: 100%; }
.problem { margin-top: 12px; font-weight: 800; }
.problem:empty { display: none; }
.pairing .notice { max-width: 26rem; margin: 18px auto 0; color: var(--text); opacity: 0.85; }
.panel .lead { margin-top: 8px; }
.panel .problem[role="status"] { font-weight: 600; }
#unlock-box { margin-top: 4px; }
/* A tick box is not a text box: its own size, and its label beside it. */
input[type="checkbox"] { width: 26px; height: 26px; flex: none; padding: 0; accent-color: var(--blush); }
.switch { display: flex; align-items: center; gap: 12px; margin: 12px 0 0; font-weight: 800; }

/* ---------- the conversation ---------- */
.talk { position: relative; display: flex; flex-direction: column; }
.hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 14px;
  font-size: 0.9rem;
  font-weight: 700;
  color: #1b1f3b;
  background: var(--lemon);
  border-bottom: var(--outline);
}
.hint p { flex: 1; }
.hint button { min-height: 40px; padding: 6px 12px; font-size: 0.9rem; box-shadow: 2px 2px 0 #1b1f3b; }

/* ---------- a mission's step, waiting for a yes or a no ---------- */
/* Above the conversation and outside what scrolls, so that it cannot be scrolled past
   or missed. It takes no room at all when nothing is being asked. */
.asks {
  flex: none;
  /* As much of the screen as leaves a strip of the conversation in sight; a question
     longer than that scrolls inside its own band. */
  max-height: max(200px, calc(100dvh - 232px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 12px 16px;
  color: #1b1f3b;
  background: var(--lemon);
  border-bottom: var(--outline);
}
.asks-head { font-size: 0.82rem; font-weight: 800; }
.ask {
  margin-top: 10px;
  padding: 14px 14px 16px;
  color: var(--text);
  background: var(--card);
  border: var(--outline);
  box-shadow: var(--drop);
}
.ask + .ask { margin-top: 16px; }
.ask > * { margin: 0; }
.ask-mission { font-size: 0.86rem; font-weight: 700; color: var(--soft); }
.ask-title { margin-top: 2px; font-size: 1.2rem; font-weight: 800; line-height: 1.25; }
.ask-where { margin-top: 10px; font-size: 0.86rem; font-weight: 800; }
/* The whole of it, wrapped: this is what is being agreed to. Never cut short. */
.ask-command {
  margin: 4px 0 0;
  padding: 10px 12px;
  font: 0.92rem/1.5 ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* A direction mark in a command must not reorder what is read. */
  direction: ltr;
  unicode-bidi: isolate;
  color: var(--paper);
  background: var(--ink);
  border: var(--outline);
}
.ask-reason { margin-top: 10px; font-size: 0.95rem; }
/* Far enough apart that a thumb aimed at one does not land on the other. */
.ask-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 16px; }
.ask-buttons button { min-height: 52px; padding: 10px 8px; }
.ask-note { margin-top: 12px; font-weight: 800; }
.ask-note:empty { display: none; }
@media (max-width: 340px) {
  .ask-buttons { grid-template-columns: 1fr; gap: 18px; }
}
/* ---------- pinned mission bridge ---------- */
.pinned {
  flex: none;
  max-height: max(220px, calc(100dvh - 220px));
  overflow-y: auto;
  padding: 8px 12px;
  color: var(--text);
  background: var(--card);
  border-bottom: var(--outline);
}
.pinned summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-weight: 800;
  cursor: pointer;
}
.pinned-badge {
  padding: 1px 8px;
  font-size: 0.72rem;
  color: #1b1f3b;
  background: var(--sky);
  border: 2px solid var(--line);
}
.pinned-title { font-size: 0.96rem; flex: 1 1 auto; }
.pinned-meta { font-size: 0.78rem; color: var(--soft); }
.pinned-body { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.pinned-goal, .pinned-wake, .pinned-issue { font-size: 0.88rem; }
.pinned-issue { font-weight: 800; color: var(--blush); }
.pinned-steps, .pinned-thread {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.86rem;
}
.pinned-cmd {
  margin: 4px 0;
  padding: 6px 8px;
  font: 0.8rem/1.4 ui-monospace, "SF Mono", monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--paper);
  background: var(--ink);
  border: 2px solid var(--line);
}
.pinned-steer { display: flex; gap: 8px; margin-top: 4px; }
.pinned-steer input { flex: 1; font-size: 0.94rem; padding: 8px 10px; }
.pinned-steer button { min-height: 42px; padding: 8px 14px; }
.pinned-actions { display: flex; gap: 8px; }
.pinned-actions button { min-height: 40px; padding: 6px 12px; font-size: 0.85rem; }
.trace-drawer summary { font-weight: 800; cursor: pointer; }
.trace-list {
  margin: 10px 0 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.84rem;
}
.trace-entry {
  padding: 8px 10px;
  border: 2px solid var(--line);
  background: var(--page);
}
.trace-entry p { margin-top: 4px; font-size: 0.82rem; overflow-wrap: anywhere; }
.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.scroll::-webkit-scrollbar { width: 5px; }
.scroll::-webkit-scrollbar-thumb { background: var(--line); }
.thread {
  padding: 14px 14px 18px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.thread li { display: flex; flex-direction: column; max-width: 100%; }
.bubble {
  max-width: 92%;
  padding: 10px 14px 11px;
  font-size: 1.0625rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
  border: var(--outline);
}
.when { margin-top: 5px; font-size: 0.7rem; font-weight: 700; color: var(--text); opacity: 0.62; }
.who { display: block; font-size: 0.75rem; font-weight: 800; opacity: 0.85; }
/* Her words: a speech balloon, with its tail toward her side of the page. */
.hers { align-items: flex-start; }
.hers .bubble {
  position: relative;
  min-width: 3.2rem;
  min-height: 2.9rem;
  background: var(--card);
  border-radius: 18px 18px 18px 4px;
  box-shadow: var(--drop);
}
.hers .bubble::before {
  content: "";
  position: absolute;
  left: 12px;
  bottom: -11px;
  width: 14px;
  height: 14px;
  background: var(--card);
  border-right: var(--outline);
  border-bottom: var(--outline);
  transform: skewX(38deg) rotate(8deg);
}
.hers .when { margin: 13px 0 0 6px; }
.bubble p { white-space: pre-wrap; }
.bubble p + p, .bubble p + ul, .bubble ul + p, .bubble p + ol, .bubble ol + p { margin-top: 0.7em; }
.bubble ul, .bubble ol { padding-left: 1.25em; }
.bubble ul { list-style: disc; }
.bubble ol { list-style: decimal; }
.bubble li { display: list-item; margin: 0.2em 0; }
.bubble code {
  padding: 1px 5px;
  font-family: ui-monospace, "Noto Sans Mono", monospace;
  font-size: 0.9em;
  background: rgb(89 200 245 / 28%);
  border-radius: 4px;
}
/* What was said to her: a narration box, the way a caption sits in a panel. */
.said { align-items: flex-end; }
.said .bubble {
  max-width: 84%;
  white-space: pre-wrap;
  color: var(--mine-text);
  background: var(--mine);
  box-shadow: 3px 3px 0 var(--blush);
}
.said.other .bubble { color: var(--text); background: var(--card); box-shadow: 3px 3px 0 var(--haze); }
.said .when { margin-right: 2px; }
.note, .caution { align-items: center; }
.note .bubble, .caution .bubble {
  max-width: 100%;
  padding: 5px 13px 6px;
  font-size: 0.92rem;
  font-weight: 700;
  color: #1b1f3b;
  background: var(--lemon);
  transform: rotate(-0.6deg);
}
.caution .bubble { background: var(--blush); transform: rotate(0.5deg); }
.day {
  align-items: center;
  font-size: 0.75rem;
  font-weight: 800;
  color: var(--text);
  opacity: 0.7;
}

/* Nothing said yet: a few real things to ask, and what she will not do from here. */
.start { padding: 22px 16px 26px; }
.start h2 { font-size: 1.55rem; font-weight: 800; line-height: 1.15; }
.start .away, body[data-link="lost"] .start .here { display: none; }
body[data-link="lost"] .start .away { display: inline; }
.start .lead { margin-top: 6px; font-weight: 700; }
.chips { margin: 16px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.chips button {
  width: 100%;
  text-align: left;
  font-weight: 700;
  color: var(--text);
  background: var(--card);
}
.start .limits {
  margin-top: 20px;
  padding: 10px 12px;
  font-size: 0.9rem;
  border-left: 5px solid var(--line);
  background: rgb(255 255 255 / 22%);
}
.start .notice { margin-top: 18px; color: var(--text); opacity: 0.8; }

.jump {
  position: absolute;
  right: 14px;
  bottom: calc(86px + var(--safe-bottom));
  min-height: 40px;
  padding: 6px 14px;
  font-size: 0.9rem;
  background: var(--lemon);
  z-index: 2;
}
.offline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 14px;
  font-size: 0.9rem;
  font-weight: 700;
  background: var(--card);
  border-top: var(--outline);
}
.offline p { flex: 1; }
.offline button { min-height: 40px; padding: 6px 12px; font-size: 0.9rem; }
.activity {
  align-self: flex-start;
  max-width: calc(100% - 28px);
  margin: 0 14px 10px;
  padding: 4px 12px 5px;
  font-size: 0.9rem;
  font-weight: 800;
  color: var(--text);
  background: var(--card);
  border: var(--outline);
  box-shadow: 3px 3px 0 var(--line);
}
.activity:empty { display: none; }
.activity::after { content: ""; display: inline-block; width: 1.4em; text-align: left; }
.thinking .activity::after { content: "…"; animation: wait 1.2s steps(2) infinite; }
.activity[data-kind="waiting"] { color: #1b1f3b; background: var(--lemon); }
.activity[data-kind="waiting"]::after { content: ""; animation: none; }
@keyframes wait { 50% { opacity: 0.2; } }
.composer {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  padding: 10px 12px calc(10px + var(--safe-bottom));
  background: var(--card);
  border-top: var(--outline);
}
.composer textarea { flex: 1; min-height: 48px; max-height: 9.5em; resize: none; line-height: 1.35; }
.composer button { min-width: 68px; }
#stop { background: var(--lemon); }
.voice-hold {
  background: var(--sky);
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.voice-hold[data-recording="yes"] { background: var(--blush); color: #1b1f3b; }
.outbox {
  margin: 0 14px 8px;
  padding: 8px 10px;
  background: var(--card);
  border: var(--outline);
  font-size: 0.86rem;
}
.outbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 800;
}
.outbox-head button { min-height: 32px; padding: 4px 10px; font-size: 0.78rem; }
.outbox-list {
  margin: 6px 0 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.outbox-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.outbox-item span { flex: 1; overflow-wrap: anywhere; }
.outbox-item button { min-height: 28px; padding: 2px 8px; font-size: 0.75rem; }

/* ---------- the sheet for this device ---------- */
dialog.sheet {
  position: fixed;
  inset: auto 0 0 0;
  width: 100%;
  max-width: 34rem;
  max-height: 86dvh;
  margin: 0 auto;
  padding: 18px 16px calc(18px + var(--safe-bottom));
  overflow-y: auto;
  color: var(--text);
  background: var(--card);
  border: var(--outline);
  border-bottom: 0;
  border-radius: 18px 18px 0 0;
}
dialog.sheet::backdrop { background: rgb(9 11 26 / 55%); }
dialog.sheet[open] { animation: rise 0.22s ease-out; }
@keyframes rise { from { transform: translateY(24px); opacity: 0.4; } }
.sheet h2 { font-size: 1.25rem; font-weight: 800; }
.sheet h3 { font-size: 1rem; font-weight: 800; }
.sheet h2:focus { outline: none; }
.sheet .device { margin-top: 4px; }
.sheet section { margin-top: 16px; padding-top: 14px; border-top: 2px dashed var(--line); }
.sheet section p { margin-top: 6px; font-size: 0.92rem; }
.sheet section p.notice { font-size: 0.74rem; }
.sheet .steps { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.sheet .steps button { flex: 1 1 auto; }
.sheet .note { font-weight: 800; }
.sheet .note:empty { display: none; }
.sheet .note a { color: inherit; }
.sheet .close { width: 100%; margin-top: 22px; }

@media (max-width: 380px) {
  .top { column-gap: 9px; padding-left: 10px; padding-right: 8px; }
  .plate { font-size: 1.15rem; padding: 1px 9px 3px; }
  .mark { width: 40px; height: 40px; }
  .fan { font-size: 0.64rem; }
  .bubble { font-size: 1rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  button:active { transform: none; }
}
`;
