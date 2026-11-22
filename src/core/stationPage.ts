import { UNOFFICIAL_NOTICE } from "../shared/ipc.ts";
import { STATION_SCRIPT } from "./stationPageScript.ts";
import { STATION_STYLE } from "./stationPageStyle.ts";

/**
 * The page her station serves to Captain's other devices: a chat with her, made for one
 * hand on a tall phone. The Android app shows this same page. It is one document with
 * nothing fetched from anywhere else, and it holds no character art and no part of the
 * model: only words, and a small abstract mark that moves with her mood.
 *
 * Whatever she or anyone else wrote is put on the page as text, never as markup.
 */

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The whole page. `nonce` is a fresh random value for this one response: the page's own
 * style and script carry it, and the browser is told to run nothing that does not.
 */
export function stationPage(nonce: string): string {
  const safeNonce = nonce.replace(/[^A-Za-z0-9+/=_-]/g, "");
  const notice = escapeHtml(UNOFFICIAL_NOTICE);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#1b1f3b">
<title>AI-chan station (unofficial fan project)</title>
<style nonce="${safeNonce}">${STATION_STYLE}</style>
</head>
<body data-mood="neutral" data-link="off">
<header class="top">
  <div class="mark" id="mark" aria-hidden="true">
    <svg viewBox="0 0 48 48" focusable="false">
      <path fill="#1b1f3b" d="M24 4l5.2 14.8L44 24l-14.8 5.2L24 44l-5.2-14.8L4 24l14.8-5.2z"/>
      <path class="glint" fill="#1b1f3b" d="M41 3l1.7 4.3L47 9l-4.3 1.7L41 15l-1.7-4.3L35 9l4.3-1.7z"/>
    </svg>
  </div>
  <div class="name">
    <h1 class="plate">AI-chan</h1>
    <p class="fan">Unofficial fan project</p>
  </div>
  <div class="state">
    <p class="link" id="link" role="status">not paired</p>
    <p class="mood" id="mood" data-mood="neutral" hidden>calm</p>
  </div>
  <button type="button" class="menu" id="menu-open" aria-label="This device and the app" hidden>
    <span></span><span></span><span></span>
  </button>
</header>
<main id="pair" class="pairing" hidden>
  <section class="panel">
    <h2>Pair this phone with her</h2>
    <ol class="steps-list">
      <li>On the PC, open her Settings and find <strong>Your other devices</strong>.</li>
      <li>Press <strong>Show a pairing code</strong>.</li>
      <li>Type the six digits here. They work for five minutes.</li>
    </ol>
    <form id="pair-form">
      <label for="code">Code from the PC</label>
      <input id="code" name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="7" placeholder="000 000" required>
      <label for="name">What to call this device</label>
      <input id="name" name="name" maxlength="40" autocomplete="off" placeholder="Phone">
      <button type="submit" id="pair-button">Pair</button>
      <p class="problem" id="pair-problem" role="alert"></p>
    </form>
  </section>
  <p class="notice">${notice}</p>
</main>
<main id="sign" class="pairing" hidden>
  <section class="panel" id="no-account" hidden>
    <h2>Set a name and password on the PC first</h2>
    <p class="lead">This device is paired, but nobody can use her from it until a name and password have been chosen. On the PC, open her Settings, go to <strong>Devices</strong> and set them there. Then come back here and sign in.</p>
    <button type="button" id="account-check">Check again</button>
    <p class="problem" id="account-note" role="status"></p>
  </section>
  <section class="panel" id="sign-in" hidden>
    <h2>Sign in</h2>
    <p class="lead">With the name and password you set on the PC. They are asked for every time this is opened, and again after half an hour without use.</p>
    <div id="unlock-box" hidden>
      <button type="button" id="unlock">Unlock with fingerprint or face</button>
    </div>
    <form id="sign-form">
      <label for="sign-name">Name</label>
      <input id="sign-name" name="username" maxlength="32" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
      <label for="sign-password">Password</label>
      <input id="sign-password" name="password" type="password" maxlength="200" autocomplete="current-password" required>
      <button type="submit" id="sign-button">Sign in</button>
      <p class="problem" id="sign-problem" role="alert"></p>
    </form>
    <button type="button" class="quiet" id="reset">Forgot the password?</button>
    <p class="problem" id="reset-note" role="status"></p>
  </section>
  <p class="notice">${notice}</p>
</main>
<main id="talk" class="talk" hidden>
  <div class="hint" id="app-hint" hidden>
    <p>There is an app for this phone.</p>
    <button type="button" id="app-hint-open">Get it</button>
  </div>
  <section class="pinned" id="pinned" aria-label="Pinned mission" hidden>
    <details id="pinned-details">
      <summary id="pinned-summary">
        <span class="pinned-badge">Pinned mission</span>
        <span class="pinned-title" id="pinned-title"></span>
        <span class="pinned-meta" id="pinned-meta"></span>
      </summary>
      <div class="pinned-body">
        <p class="pinned-goal" id="pinned-goal" hidden></p>
        <p class="pinned-wake" id="pinned-wake" hidden></p>
        <p class="pinned-issue" id="pinned-issue" role="status" hidden></p>
        <ol class="pinned-steps" id="pinned-steps"></ol>
        <ol class="pinned-thread" id="pinned-thread"></ol>
        <form class="pinned-steer" id="steer-form" hidden>
          <input id="steer-input" maxlength="600" placeholder="Add a steering note to this mission" aria-label="Steering note">
          <button type="submit" id="steer-send">Note</button>
        </form>
        <div class="pinned-actions">
          <button type="button" class="quiet" id="pinned-stop" hidden>Stop mission</button>
        </div>
        <p class="note" id="pinned-note" role="status"></p>
      </div>
    </details>
  </section>
  <section class="asks" id="asks" aria-live="assertive" aria-label="A mission is waiting for your answer" hidden></section>
  <div class="scroll" id="scroll">
    <section class="start" id="start">
      <h2><span class="here">She's on the line.</span><span class="away">She's out of reach right now.</span></h2>
      <p class="lead">Ask her anything you would ask at the PC. Some places to start:</p>
      <ul class="chips" id="chips">
        <li><button type="button" data-say="Remind me in 20 minutes to ">Remind me in 20 minutes to…</button></li>
        <li><button type="button" data-say="How is the ship doing?">How is the ship doing?</button></li>
        <li><button type="button" data-say="What is 18% of 240?">What is 18% of 240?</button></li>
        <li><button type="button" data-say="What's the weather tomorrow?">What's the weather tomorrow?</button></li>
      </ul>
      <p class="limits">What she asks you about in a conversation is asked at the PC only, and from here she will not look at the PC's screen or listen to it. When a mission reaches a step that needs your yes, it is shown here and you can answer it; a step that touches where passwords or keys are kept is asked at the PC only.</p>
      <p class="notice">${notice}</p>
    </section>
    <ol class="thread" id="thread" aria-live="polite" aria-label="Conversation"></ol>
  </div>
  <button type="button" class="jump" id="jump" hidden>New reply</button>
  <section class="outbox" id="outbox" aria-label="Queued messages" hidden>
    <div class="outbox-head">
      <span id="outbox-count"></span>
      <button type="button" class="quiet" id="outbox-clear">Clear</button>
    </div>
    <ol class="outbox-list" id="outbox-list"></ol>
  </section>
  <div class="offline" id="offline" hidden>
    <p><span id="offline-words" role="status"></span> <span id="offline-count" aria-hidden="true"></span></p>
    <button type="button" class="quiet" id="retry">Try now</button>
  </div>
  <p class="activity" id="activity" role="status"></p>
  <form class="composer" id="say-form">
    <textarea id="say" rows="1" maxlength="2000" placeholder="Say something to her" aria-label="Message to her" enterkeyhint="send"></textarea>
    <button type="button" class="quiet voice-hold" id="voice-hold" aria-label="Hold to talk">Hold</button>
    <button type="button" id="stop" hidden>Stop</button>
    <button type="submit" id="send">Send</button>
  </form>
</main>
<dialog class="sheet" id="sheet" aria-labelledby="sheet-title">
  <h2 id="sheet-title" tabindex="-1" autofocus>This device</h2>
  <p class="device" id="sheet-device"></p>
  <aside id="get-app" class="get-app" hidden>
    <section>
      <h3>The app for this phone</h3>
      <p>It opens straight to her, with no address to type and no certificate warning.</p>
      <div class="steps">
        <button type="button" id="app-download">1. Download the app</button>
        <button type="button" id="app-open">2. Open it, paired</button>
        <button type="button" id="app-later" class="quiet">Not now</button>
      </div>
      <p class="note" id="app-note" role="status"></p>
    </section>
  </aside>
  <section>
    <h3>Signed in</h3>
    <p>Closing this signs you out, and so does half a day. Signing out here does it now.</p>
    <div id="unlock-setting" hidden>
      <label class="switch" for="unlock-switch"><input type="checkbox" id="unlock-switch"> <span>Unlock with fingerprint or face on this phone</span></label>
      <p class="note" id="unlock-note" role="status"></p>
    </div>
    <div id="alerts-setting" hidden>
      <label class="switch" for="alerts-switch"><input type="checkbox" id="alerts-switch"> <span>Background alerts for standing orders</span></label>
      <p class="note" id="alerts-note" role="status"></p>
    </div>
    <div class="steps"><button type="button" class="quiet" id="sign-out">Sign out</button></div>
  </section>
  <section>
    <h3>Unpair</h3>
    <p>This device stops being able to talk to her. The PC keeps it on its list until you remove it there.</p>
    <div class="steps"><button type="button" class="quiet" id="forget">Forget this pairing</button></div>
  </section>
  <section>
    <details id="trace-drawer" class="trace-drawer">
      <summary>Turn inspector (this device)</summary>
      <p>Prompt tokens, active tool schemas, permission checks, and stage timings for replies sent from paired devices.</p>
      <div class="steps"><button type="button" class="quiet" id="trace-refresh">Refresh traces</button></div>
      <p class="note" id="trace-status" role="status"></p>
      <ol class="trace-list" id="trace-list"></ol>
    </details>
  </section>
  <section>
    <h3>About</h3>
    <p class="notice">${notice}</p>
  </section>
  <button type="button" class="close" id="sheet-close">Close</button>
</dialog>
<script nonce="${safeNonce}">${STATION_SCRIPT}</script>
</body>
</html>
`;
}
