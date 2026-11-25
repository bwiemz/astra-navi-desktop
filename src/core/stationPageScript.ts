/**
 * What the station's page does: the one script of `stationPage.ts`, carried in the page
 * itself and run in the visitor's browser or in the Android app's window, never here.
 * It is plain JavaScript in a string for that reason, and is tested by running it
 * against a pretend page (`tests/stationPageScript.test.ts`).
 *
 * Whatever she or anyone else wrote is put on the page as text, never as markup. What
 * says who is signed in is held in a variable of this script only, so that closing the
 * page ends it.
 */

export const STATION_SCRIPT = String.raw`
(function () {
  "use strict";
  var TOKEN_KEY = "aichan.station.token";
  var NAME_KEY = "aichan.station.name";
  var APP_KEY = "aichan.station.app";
  var OUTBOX_KEY = "aichan.station.outbox";
  var MAX_OUTBOX = 20;
  var MOODS = ["neutral", "happy", "excited", "thinking", "surprised", "worried", "smug", "sad"];
  var MAX_ITEMS = 200;
  var TICK = String.fromCharCode(96);

  function byId(id) { return document.getElementById(id); }
  var body = document.body;
  var pairView = byId("pair"), signView = byId("sign"), talkView = byId("talk");
  var noAccount = byId("no-account"), signBox = byId("sign-in"), accountNote = byId("account-note");
  var signName = byId("sign-name"), signPassword = byId("sign-password"), signButton = byId("sign-button");
  var signProblem = byId("sign-problem"), resetNote = byId("reset-note");
  var unlockBox = byId("unlock-box"), unlockSetting = byId("unlock-setting");
  var unlockSwitch = byId("unlock-switch"), unlockNote = byId("unlock-note");
  var scroller = byId("scroll"), thread = byId("thread"), start = byId("start");
  var link = byId("link"), mood = byId("mood"), mark = byId("mark"), activity = byId("activity");
  var say = byId("say"), send = byId("send"), stop = byId("stop"), jump = byId("jump");
  var voiceHold = byId("voice-hold");
  var outbox = byId("outbox"), outboxCount = byId("outbox-count");
  var outboxList = byId("outbox-list"), outboxClear = byId("outbox-clear");
  var alertsSetting = byId("alerts-setting"), alertsSwitch = byId("alerts-switch"), alertsNote = byId("alerts-note");
  var offline = byId("offline"), offlineWords = byId("offline-words"), offlineCount = byId("offline-count");
  var problem = byId("pair-problem"), pairButton = byId("pair-button"), codeBox = byId("code");
  var sheet = byId("sheet"), menuOpen = byId("menu-open"), forget = byId("forget");
  var getApp = byId("get-app"), appNote = byId("app-note"), appHint = byId("app-hint");
  var asks = byId("asks");
  var pinnedBox = byId("pinned"), pinnedDetails = byId("pinned-details");
  var pinnedTitle = byId("pinned-title"), pinnedMeta = byId("pinned-meta");
  var pinnedGoal = byId("pinned-goal"), pinnedWake = byId("pinned-wake"), pinnedIssue = byId("pinned-issue");
  var pinnedSteps = byId("pinned-steps"), pinnedThread = byId("pinned-thread");
  var steerForm = byId("steer-form"), steerInput = byId("steer-input"), steerSend = byId("steer-send");
  var pinnedStop = byId("pinned-stop"), pinnedNote = byId("pinned-note");
  var traceDrawer = byId("trace-drawer"), traceRefresh = byId("trace-refresh");
  var traceStatus = byId("trace-status"), traceList = byId("trace-list");
  // Inside the app the page says so in how it names itself, and does not offer the app again.
  var inApp = /AstraNaviApp\/|AIChanApp\//.test(navigator.userAgent);
  var onAndroid = /Android/.test(navigator.userAgent);
  var appOnOffer = false;

  function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function keep(key, value) {
    try {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* private browsing: the pairing lasts as long as the page */ }
  }

  var token = stored(TOKEN_KEY);
  var myName = stored(NAME_KEY) || "";
  // Who is signed in. Held here and nowhere else: never in storage, a cookie or the
  // address, so closing or reloading the page is signing out.
  var session = null;
  // The phone app, when this page is inside it: it can keep a key behind the phone's own
  // fingerprint or face check, and hand it back after that check.
  var app = window.AstraNaviApp || window.AiChanApp || null;
  var promptedToUnlock = false; // the phone's check is put up by itself once per opening
  var waitingToUnlock = false;  // the app left the foreground while the sign-in screen was up
  var reader = null;      // the open stream of events
  var attempt = 0;        // which try at the stream is the current one; older ones are ignored
  var streamStop = null;  // stops the current try's request
  var retryMs = 1000;
  var retryTimer = 0;
  var retryAt = 0;        // when the next try is due, for the countdown
  var countdown = 0;
  var bubble = null;      // her reply being written
  var written = "";
  var lastDay = "";       // the day of the newest message, for the separators
  var stick = true;       // the thread follows the newest message until the user scrolls up
  var cards = {};         // the mission steps waiting for a yes or no here, by the question's id
  var pinnedId = null;    // the id of the single mission pinned to paired devices
  var outboxItems = [];   // queued messages saved while out of range
  var drainingOutbox = false;
  var voiceRecording = false;
  var webAudio = null;    // active Web Audio capture state when outside the APK

  function setLink(state, words) {
    link.dataset.state = state;
    link.textContent = words;
    body.dataset.link = state;
  }

  function appWanted() {
    return appOnOffer && onAndroid && !inApp && !!token && talkView.hidden === false;
  }
  function offerApp() {
    getApp.hidden = !appWanted();
    appHint.hidden = !(appWanted() && stored(APP_KEY) !== "later");
  }

  function canUnlock() {
    try { return !!app && app.canUnlock() === true; } catch (e) { return false; }
  }
  function hasKey() {
    try { return !!app && app.hasKey() === true; } catch (e) { return false; }
  }
  function forgetKey() {
    try { if (app) app.forgetKey(); } catch (e) { /* nothing kept */ }
  }
  function canPollAlerts() {
    try { return !!app && typeof app.canPollAlerts === "function" && app.canPollAlerts() === true; }
    catch (e) { return false; }
  }
  function canNativeVoice() {
    try { return !!app && typeof app.canRecordVoice === "function" && app.canRecordVoice() === true; }
    catch (e) { return false; }
  }
  function canWebVoice() {
    return Boolean(typeof navigator !== "undefined" && navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      (window.AudioContext || window.webkitAudioContext));
  }
  if (voiceHold) voiceHold.hidden = !(canNativeVoice() || canWebVoice());

  function show(view) {
    pairView.hidden = view !== "pair";
    signView.hidden = view !== "sign";
    talkView.hidden = view !== "talk";
    mood.hidden = view !== "talk";
    menuOpen.hidden = view !== "talk";
    offerApp();
    if (view === "pair") {
      setLink("off", "not paired");
      if (sheet.open) sheet.close();
    }
    if (view === "sign") {
      setLink("off", "not signed in");
      if (sheet.open) sheet.close();
    }
  }

  // ----- her text: only ever placed as text -----
  // Bold and code are the two marks she uses, and each becomes a real element holding
  // plain text.
  function write(element, text) {
    var plain = "";
    function flush() {
      if (plain) { element.appendChild(document.createTextNode(plain)); plain = ""; }
    }
    var i = 0;
    while (i < text.length) {
      if (text.startsWith("**", i)) {
        var end = text.indexOf("**", i + 2);
        if (end > i + 2) {
          flush();
          var strong = document.createElement("strong");
          strong.textContent = text.slice(i + 2, end);
          element.appendChild(strong);
          i = end + 2;
          continue;
        }
      }
      if (text[i] === TICK) {
        var close = text.indexOf(TICK, i + 1);
        if (close > i + 1) {
          flush();
          var code = document.createElement("code");
          code.textContent = text.slice(i + 1, close);
          element.appendChild(code);
          i = close + 1;
          continue;
        }
      }
      plain += text[i];
      i += 1;
    }
    flush();
  }

  // Her replies as paragraphs and lists: a blank line starts a new paragraph, and lines
  // that begin with a dash or a number become a list. Still nothing but text nodes.
  function writeRich(element, text) {
    element.textContent = "";
    var lines = text.split("\n");
    var para = [];
    var list = null;
    function endPara() {
      if (!para.length) return;
      var p = document.createElement("p");
      write(p, para.join("\n"));
      element.appendChild(p);
      para = [];
    }
    function endList() { list = null; }
    for (var n = 0; n < lines.length; n += 1) {
      var line = lines[n];
      var bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      var numbered = bullet ? null : /^\s*\d{1,2}[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        endPara();
        var kind = bullet ? "UL" : "OL";
        if (!list || list.tagName !== kind) {
          list = document.createElement(kind === "UL" ? "ul" : "ol");
          element.appendChild(list);
        }
        var item = document.createElement("li");
        write(item, (bullet || numbered)[1]);
        list.appendChild(item);
      } else if (line.trim() === "") {
        endPara();
        endList();
      } else {
        endList();
        para.push(line);
      }
    }
    endPara();
  }

  // ----- the thread -----
  function nearEnd() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  }
  function toEnd() {
    scroller.scrollTop = scroller.scrollHeight;
    stick = true;
    jump.hidden = true;
  }
  function arrived() {
    if (stick) toEnd(); else jump.hidden = false;
  }
  scroller.addEventListener("scroll", function () {
    stick = nearEnd();
    if (stick) jump.hidden = true;
  }, { passive: true });
  jump.addEventListener("click", toEnd);

  function two(number) { return number < 10 ? "0" + number : String(number); }
  function clock(date) { return two(date.getHours()) + ":" + two(date.getMinutes()); }
  function dayKey(date) { return date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate(); }
  function dayName(date) {
    var today = new Date();
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return "Today";
    if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
    try {
      return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    } catch (e) { return date.toDateString(); }
  }

  function trim() {
    while (thread.children.length > MAX_ITEMS) thread.removeChild(thread.firstChild);
    start.hidden = thread.children.length > 0;
  }

  function add(kind, text, who, when) {
    var date = when && !isNaN(when.getTime()) ? when : new Date();
    if (dayKey(date) !== lastDay) {
      lastDay = dayKey(date);
      var day = document.createElement("li");
      day.className = "day";
      day.textContent = dayName(date);
      thread.appendChild(day);
    }
    var item = document.createElement("li");
    item.className = kind;
    var box = document.createElement("div");
    box.className = "bubble";
    if (who) {
      var label = document.createElement("span");
      label.className = "who";
      label.textContent = who;
      box.appendChild(label);
    }
    var words = document.createElement("div");
    if (kind === "hers") writeRich(words, text); else words.textContent = text;
    box.appendChild(words);
    item.appendChild(box);
    if (kind === "hers" || kind.indexOf("said") === 0) {
      var time = document.createElement("time");
      time.className = "when";
      time.textContent = clock(date);
      item.appendChild(time);
    }
    thread.appendChild(item);
    trim();
    arrived();
    return words;
  }

  function addSaid(text, from, when) {
    var mine = !from || from === myName;
    add(mine ? "said" : "said other", text, mine ? "" : from, when);
  }

  function setActivity(kind, words) {
    activity.dataset.kind = kind;
    activity.textContent = words;
  }

  function setThinking(on) {
    body.classList.toggle("thinking", on);
    stop.hidden = !on;
    send.hidden = on;
    thread.setAttribute("aria-busy", on ? "true" : "false");
    setActivity(on ? "thinking" : "", on ? "She is thinking" : "");
  }

  function setMood(name) {
    if (MOODS.indexOf(name) === -1 || body.dataset.mood === name) return;
    body.dataset.mood = name;
    mood.dataset.mood = name;
    mood.textContent = name === "neutral" ? "calm" : name;
    mark.classList.remove("pop");
    void mark.offsetWidth; // lets the same little jump play again
    mark.classList.add("pop");
  }

  // ----- a mission's step, waiting for a yes or a no -----
  // Everything on a card is put there as text. Nothing answers one but a tap on one of
  // its two buttons: not Enter in the message box, not signing in, not a tap elsewhere.
  function piece(tag, name, text) {
    var made = document.createElement(tag);
    made.className = name;
    made.textContent = text;
    return made;
  }

  var asksHead = piece("p", "asks-head", "");

  // A card that has only just appeared cannot be answered yet: a finger already on its
  // way to something else (the sign-in button, another card) must not land on "Allow".
  var CARD_WAKES_MS = 800;

  function wakeLater(id, card) {
    clearTimeout(card.wake);
    card.ready = false;
    card.allow.disabled = true;
    card.deny.disabled = true;
    card.wake = setTimeout(function () {
      if (cards[id] !== card || card.busy || card.done) return;
      card.ready = true;
      card.allow.disabled = false;
      card.deny.disabled = false;
    }, CARD_WAKES_MS);
  }

  function restCards() {
    Object.keys(cards).forEach(function (id) {
      var card = cards[id];
      if (!card.busy && !card.done) wakeLater(id, card);
    });
  }

  function dropCards() {
    Object.keys(cards).forEach(function (id) { clearTimeout(cards[id].wake); });
    cards = {};
    asks.textContent = "";
    asks.hidden = true;
  }

  function renderPinned(mission) {
    if (!mission || !mission.id) {
      pinnedId = null;
      pinnedBox.hidden = true;
      pinnedTitle.textContent = "";
      pinnedMeta.textContent = "";
      pinnedGoal.hidden = true;
      pinnedWake.hidden = true;
      pinnedIssue.hidden = true;
      pinnedSteps.textContent = "";
      pinnedThread.textContent = "";
      steerForm.hidden = true;
      pinnedStop.hidden = true;
      pinnedStop.dataset.sure = "";
      pinnedStop.textContent = "Stop mission";
      pinnedNote.textContent = "";
      return;
    }
    pinnedId = String(mission.id);
    var steps = Array.isArray(mission.steps) ? mission.steps : [];
    var doneCount = 0;
    steps.forEach(function (s) { if (s.state === "done") doneCount += 1; });
    pinnedTitle.textContent = String(mission.title || "Mission");
    pinnedMeta.textContent = String(mission.state || "") + " (" + doneCount + "/" + steps.length + ")";
    if (mission.goal) { pinnedGoal.textContent = "Goal: " + String(mission.goal); pinnedGoal.hidden = false; }
    else { pinnedGoal.hidden = true; }
    if (mission.wake) { pinnedWake.textContent = "Wake: " + String(mission.wake); pinnedWake.hidden = false; }
    else { pinnedWake.hidden = true; }
    if (mission.note) { pinnedIssue.textContent = String(mission.note); pinnedIssue.hidden = false; }
    else { pinnedIssue.hidden = true; }

    pinnedSteps.textContent = "";
    steps.forEach(function (step) {
      var li = document.createElement("li");
      li.appendChild(piece("strong", "", "[" + String(step.state || "") + "] " + String(step.title || "") + " (" + String(step.where || "this PC") + ")"));
      li.appendChild(piece("pre", "pinned-cmd", String(step.command || "")));
      if (step.outputPreview) li.appendChild(piece("p", "", "Output (program text): " + String(step.outputPreview)));
      var arts = Array.isArray(step.artifacts) ? step.artifacts : [];
      if (arts.length > 0) {
        var names = arts.map(function (a) { return String(a.name || "artifact") + " (" + Number(a.bytes || 0) + " B)"; });
        li.appendChild(piece("p", "", "Artifacts: " + names.join(", ")));
      }
      pinnedSteps.appendChild(li);
    });

    pinnedThread.textContent = "";
    var threadList = Array.isArray(mission.thread) ? mission.thread : [];
    threadList.forEach(function (entry) {
      var li = document.createElement("li");
      var who = entry.by && entry.by.from === "pc" ? "PC"
        : entry.by && entry.by.from === "device" ? String(entry.by.name || "device")
        : "Mission";
      li.textContent = "[" + who + "] " + String(entry.text || "");
      pinnedThread.appendChild(li);
    });

    var open = mission.state !== "completed" && mission.state !== "cancelled";
    steerForm.hidden = !open;
    pinnedStop.hidden = !open;
    pinnedStop.dataset.sure = "";
    pinnedStop.textContent = "Stop mission";
    pinnedBox.hidden = false;
  }

  function clearTracesView() {
    traceStatus.textContent = "";
    traceList.textContent = "";
    traceDrawer.open = false;
  }

  function fmtMs(value) {
    return typeof value === "number" ? Math.round(value) + " ms" : "n/a";
  }

  function loadTraces() {
    if (!token || !session) return;
    traceStatus.textContent = "Loading…";
    ask("GET", "/traces", null, true)
      .then(function (result) {
        if (refused(result.status, result.data)) return;
        if (result.status !== 200) {
          traceStatus.textContent = result.data.error || "Could not load traces.";
          return;
        }
        var items = Array.isArray(result.data.traces) ? result.data.traces : [];
        traceList.textContent = "";
        if (items.length === 0) {
          traceStatus.textContent = "No turns from paired devices recorded yet.";
          return;
        }
        traceStatus.textContent = items.length + (items.length === 1 ? " turn" : " turns") + ", newest first.";
        items.forEach(function (trace) {
          var li = document.createElement("li");
          li.className = "trace-entry";
          li.appendChild(piece("strong", "", String(trace.said || "") + " — " + String(trace.summary || "")));
          var toks = trace.tokens || {};
          li.appendChild(piece("p", "", "Tokens: prompt " + (toks.prompt != null ? toks.prompt : "?") + ", read " + (toks.read != null ? toks.read : "?") + ", written " + (toks.written != null ? toks.written : "?") + ", held " + (toks.held != null ? toks.held : "?")));
          var tools = Array.isArray(trace.offeredTools) ? trace.offeredTools : [];
          li.appendChild(piece("p", "", "Active tools (" + tools.length + "): " + (tools.length > 0 ? tools.join(", ") : "none")));
          var ms = trace.ms || {};
          li.appendChild(piece("p", "", "Timings: total " + fmtMs(ms.whole) + ", first word " + fmtMs(ms.firstWord) + ", STT " + fmtMs(ms.stt) + ", LLM " + fmtMs(ms.llm) + ", tools " + fmtMs(ms.tools) + ", TTS " + fmtMs(ms.tts)));
          var calls = Array.isArray(trace.calls) ? trace.calls : [];
          calls.forEach(function (c) {
            var gate = c.gate ? String(c.gate) + (c.gateReason ? " (" + String(c.gateReason) + ")" : "") : (c.asked ? "asked" : "auto");
            li.appendChild(piece("p", "", "Call " + String(c.tool || "") + ": " + String(c.ended || "") + " — " + gate + ", " + fmtMs(c.ms)));
          });
          var checks = Array.isArray(trace.checks) ? trace.checks : [];
          checks.forEach(function (chk) { li.appendChild(piece("p", "", "Check: " + String(chk))); });
          traceList.appendChild(li);
        });
      })
      .catch(function () { traceStatus.textContent = NO_ANSWER; });
  }

  // How many there are is said above them: the second may be below the edge of the band.
  function countCards() {
    var many = Object.keys(cards).length;
    if (many === 0) { dropCards(); return; }
    asksHead.textContent = many === 1
      ? "Waiting for your answer"
      : many + " steps are waiting for your answer";
  }

  function removeCard(id) {
    var card = cards[id];
    if (!card) return;
    delete cards[id];
    clearTimeout(card.wake);
    asks.removeChild(card.root);
    countCards();
  }

  function showCard(given) {
    var id = String((given && given.id) || "");
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(id) || cards[id]) return;
    if (Object.keys(cards).length === 0) {
      asks.textContent = "";
      asks.appendChild(asksHead);
    }
    var root = document.createElement("article");
    root.className = "ask";
    root.dataset.id = id;
    var step = Number(given.step) || 0, steps = Number(given.steps) || 0;
    root.appendChild(piece("p", "ask-mission",
      String(given.mission || "A mission") + (step && steps ? ", step " + step + " of " + steps : "")));
    root.appendChild(piece("h3", "ask-title", String(given.title || "A step")));
    root.appendChild(piece("p", "ask-where", "Runs on " + String(given.where || "this PC") + ":"));
    root.appendChild(piece("pre", "ask-command", String(given.command || "")));
    root.appendChild(piece("p", "ask-reason", String(given.reason || "")));
    var row = document.createElement("div");
    row.className = "ask-buttons";
    var deny = piece("button", "quiet", "Do not allow");
    var allow = piece("button", "", "Allow this step");
    deny.type = "button";
    allow.type = "button";
    deny.disabled = true;
    allow.disabled = true;
    row.appendChild(deny);
    row.appendChild(allow);
    root.appendChild(row);
    var note = piece("p", "ask-note", "");
    note.setAttribute("role", "status");
    root.appendChild(note);
    var card = { root: root, row: row, allow: allow, deny: deny, note: note, busy: false, done: false, ready: false, wake: 0 };
    cards[id] = card;
    wakeLater(id, card);
    countCards();
    allow.addEventListener("click", function () { answerCard(id, true); });
    deny.addEventListener("click", function () { answerCard(id, false); });
    asks.appendChild(root);
    asks.hidden = false;
  }

  function answerCard(id, allow) {
    var card = cards[id];
    if (!card || !card.ready || card.busy || card.done) return;
    card.busy = true;
    card.allow.disabled = true;
    card.deny.disabled = true;
    card.note.textContent = "";
    // The card may be gone, or the page signed out, by the time the answer comes back.
    function still() { return cards[id] === card; }
    function again(words) {
      card.busy = false;
      card.allow.disabled = false;
      card.deny.disabled = false;
      card.note.textContent = words;
    }
    function settled(words) {
      card.busy = false;
      card.done = true;
      // Answered: the buttons go, and what was answered stands in their place.
      card.row.hidden = true;
      card.note.textContent = words;
      setTimeout(function () { if (still()) removeCard(id); }, 4000);
    }
    post("/approve", { id: id, allow: allow }, true)
      .then(function (result) {
        if (!still()) return;
        if (result.status === 200) {
          settled(allow ? "Allowed. She is carrying on." : "Not allowed. The mission stops at this step.");
          return;
        }
        if (result.status === 409) {
          settled(result.data.error || "That was answered somewhere else already.");
          return;
        }
        // Signed out in the meantime: the sign-in screen, and the question is asked again
        // after it. Signing in answers nothing; only a tap on a card does.
        if (refused(result.status, result.data)) return;
        again(result.data.error || "That did not work. Try again.");
      })
      .catch(function () { if (still()) again(NO_ANSWER); });
  }

  function handle(message) {
    switch (message.type) {
      case "hello":
        // A new stream tells again which questions are open: what was shown before
        // may have been answered elsewhere while this device was not listening.
        dropCards();
        renderPinned(null);
        myName = String(message.device || "");
        keep(NAME_KEY, myName);
        appOnOffer = message.app === true;
        offerApp();
        pullNativeOutbox();
        drainOutbox();
        break;
      case "recent":
        thread.textContent = "";
        lastDay = "";
        bubble = null;
        (message.exchanges || []).forEach(function (exchange) {
          var when = exchange.at ? new Date(String(exchange.at)) : null;
          if (exchange.said) add("said", String(exchange.said), "", when);
          if (exchange.reply) add("hers", String(exchange.reply), "", when);
        });
        trim();
        toEnd();
        break;
      case "said":
        addSaid(String(message.text || ""), String(message.from || ""));
        // What was just sent from here is always shown; what another device said does
        // not pull the thread away from someone reading further up.
        if (!message.from || String(message.from) === myName) toEnd();
        break;
      case "reply-start":
        written = "";
        bubble = add("hers", "", "");
        break;
      case "text":
        if (!bubble) { written = ""; bubble = add("hers", "", ""); }
        written += String(message.delta || "");
        writeRich(bubble, written);
        // Words are arriving: whatever she was doing or waiting for before them is over.
        if (activity.dataset.kind === "tool" || activity.dataset.kind === "waiting") {
          setActivity("thinking", "She is answering");
        }
        arrived();
        break;
      case "reply-end":
        if (bubble && !written.trim()) {
          thread.removeChild(bubble.parentNode.parentNode);
          trim();
        }
        bubble = null;
        break;
      case "status":
        setThinking(message.state === "thinking");
        break;
      case "mood":
        setMood(String(message.mood || ""));
        break;
      case "activity":
        if (message.label) setActivity("tool", String(message.label));
        else if (body.classList.contains("thinking")) setActivity("thinking", "She is thinking");
        break;
      case "needs-captain":
        setActivity("waiting",
          "Waiting for you at the PC: " + String(message.title || "she is asking before she acts"));
        break;
      case "caution":
        add("caution", String(message.message || ""), "");
        break;
      case "event":
        add("note", String(message.text || ""), "");
        if (navigator.vibrate) navigator.vibrate(80);
        break;
      case "alert": {
        var alertData = message.alert || {};
        var alertTitle = String(alertData.title || "Alert");
        var alertBody = String(alertData.body || "");
        add("note", alertBody ? alertTitle + ": " + alertBody : alertTitle, "");
        if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
        break;
      }
      case "approval":
        showCard(message.card);
        break;
      case "approval-gone":
        removeCard(String(message.id || ""));
        break;
      case "pinned-mission":
        renderPinned(message.mission || null);
        break;
      case "signed-out":
        // The session this page was opened under is over: nobody used it for half an
        // hour, half a day has passed, or the password was changed on the PC.
        signedOut("You were signed out. Sign in again.");
        break;
    }
  }

  // ----- the link to the PC -----
  // Ends whatever stream is open or on its way, so that there is never more than one.
  function dropStream() {
    attempt += 1;
    if (streamStop) { try { streamStop.abort(); } catch (e) { /* nothing left to stop */ } }
    streamStop = null;
    if (reader) reader.cancel().catch(function () { /* already closed */ });
    reader = null;
  }

  function unpaired(words) {
    token = null;
    session = null;
    cancelVoiceCapture();
    dropCards();
    renderPinned(null);
    clearTracesView();
    outboxItems = [];
    keep(OUTBOX_KEY, null);
    renderOutbox();
    try { if (app && typeof app.setAlertPolling === "function") app.setAlertPolling(false, ""); } catch (e) { /* ignore */ }
    keep(TOKEN_KEY, null);
    dropStream();
    clearTimeout(retryTimer);
    clearInterval(countdown);
    offline.hidden = true;
    offlineWords.textContent = "";
    setThinking(false);
    show("pair");
    problem.textContent = words || "";
  }

  // The seconds tick by for the eye only. A screen reader is told once that she is not
  // answering, not once a second.
  function tellOffline() {
    var left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    offlineCount.textContent = left > 0 ? "Trying again in " + left + " s." : "Trying again now.";
  }

  function later() {
    if (!token || !session) return;
    setLink("lost", "no answer");
    setThinking(false);
    clearTimeout(retryTimer);
    clearInterval(countdown);
    retryAt = Date.now() + retryMs;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
    if (offline.hidden) {
      offline.hidden = false;
      offlineWords.textContent = "She is not answering. The PC may be off or asleep.";
    }
    tellOffline();
    countdown = setInterval(tellOffline, 1000);
  }

  function connect() {
    if (!token || !session) return;
    clearTimeout(retryTimer);
    clearInterval(countdown);
    if (!offline.hidden) offlineCount.textContent = "Trying again now.";
    if (link.dataset.state !== "lost") setLink("wait", "reaching her");
    // One stream at a time: a try still on its way, or a stream still open, is ended
    // first, and anything that comes back from it afterwards is ignored.
    dropStream();
    var mine = attempt;
    streamStop = typeof AbortController === "function" ? new AbortController() : null;
    var asked = {
      headers: { Authorization: "Bearer " + token, "X-Session": session, Accept: "text/event-stream" },
      cache: "no-store",
    };
    if (streamStop) asked.signal = streamStop.signal;
    fetch("/events", asked).then(function (response) {
      if (mine !== attempt) {
        if (response.body) response.body.cancel().catch(function () { /* already closed */ });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        // Not paired any more, not signed in any more, or no name and password set:
        // the answer says which.
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (mine === attempt && !refused(response.status, data)) later();
        });
      }
      if (!response.ok || !response.body) { later(); return; }
      retryMs = 1000;
      offline.hidden = true;
      offlineWords.textContent = "";
      setLink("on", "linked");
      var own = response.body.getReader();
      reader = own;
      var decoder = new TextDecoder();
      var buffer = "";
      function pump() {
        return own.read().then(function (part) {
          if (mine !== attempt) return;
          if (part.done) { later(); return; }
          buffer += decoder.decode(part.value, { stream: true });
          var cut;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            var block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            block.split("\n").forEach(function (line) {
              // One of the lines before may have ended it: signed out, unpaired.
              if (mine !== attempt || !session) return;
              if (line.indexOf("data: ") !== 0) return;
              try { handle(JSON.parse(line.slice(6))); } catch (e) { /* a line cut short */ }
            });
            if (mine !== attempt) return;
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () { if (token && session && mine === attempt) later(); });
  }

  byId("retry").addEventListener("click", function () { retryMs = 1000; connect(); });

  function ask(method, path, body, withToken) {
    var headers = {};
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (withToken) headers.Authorization = "Bearer " + token;
    if (withToken && session) headers["X-Session"] = session;
    var asked = { method: method, headers: headers, cache: "no-store" };
    if (method === "POST") asked.body = JSON.stringify(body);
    return fetch(path, asked)
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          return { status: response.status, data: data || {} };
        });
      });
  }
  function post(path, body, withToken) { return ask("POST", path, body, withToken); }

  // ----- signing in -----
  // Being paired says this device is one of Captain's. It does not say who is holding
  // it, so every opening of the page asks for the name and password set on the PC.
  var NOT_PAIRED = "This device is no longer paired. Pair it again from the PC.";
  var NO_ANSWER = "She could not be reached. Is the PC on?";

  function quiet() {
    dropStream();
    clearTimeout(retryTimer);
    clearInterval(countdown);
    offline.hidden = true;
    offlineWords.textContent = "";
    setThinking(false);
  }

  function showNoAccount(words) {
    session = null;
    dropCards();
    quiet();
    show("sign");
    signBox.hidden = true;
    noAccount.hidden = false;
    accountNote.textContent = words || "";
  }

  function showSignIn(state, words) {
    show("sign");
    noAccount.hidden = true;
    signBox.hidden = false;
    signPassword.value = "";
    resetNote.textContent = "";
    var wait = Number(state && state.wait) || 0;
    signProblem.textContent = wait > 0
      ? "Too many wrong tries. Wait " + Math.ceil(wait / 60) + " minutes, or ask for a reset below and change the password on the PC."
      : (words || "");
    // The phone's own check, when this phone has been let in that way before.
    var byCheck = !!(state && state.unlock) && canUnlock() && hasKey();
    unlockBox.hidden = !byCheck;
    if (byCheck && wait === 0 && !promptedToUnlock) unlockNow();
  }

  function unlockNow() {
    promptedToUnlock = true;
    try { app.unlock(); } catch (e) { /* the form is there */ }
  }

  // Asks the PC how things stand for this device and shows the screen that fits.
  function enter(words) {
    if (!token) { show("pair"); return; }
    show("sign");
    noAccount.hidden = true;
    signBox.hidden = false;
    unlockBox.hidden = true;
    signProblem.textContent = words || "";
    ask("GET", "/account", null, true)
      .then(function (result) {
        // Someone signed in, or the app locked, while the answer was on its way.
        if (session || !token) return;
        if (result.status === 401) { unpaired(NOT_PAIRED); return; }
        if (result.status !== 200) { showSignIn(null, result.data.error || NO_ANSWER); return; }
        if (!result.data.set) { showNoAccount(""); return; }
        showSignIn(result.data, words);
      })
      .catch(function () { if (!session && token) showSignIn(null, NO_ANSWER); });
  }

  // ----- still here -----
  // The PC ends a session nobody has used for half an hour, and an open page does not
  // count as use. Reading and scrolling do, so a touch, a key or the wheel says so, at
  // most once a minute. Nothing says it for a page that is merely lying open.
  var ACTIVE_EVERY_MS = 60000;
  var saidActiveAt = 0;
  function stillHere() {
    if (!token || !session) return;
    var now = Date.now();
    if (now - saidActiveAt < ACTIVE_EVERY_MS) return;
    saidActiveAt = now;
    var held = session;
    post("/active", {}, true)
      .then(function (result) {
        if (session === held && result.status !== 200) refused(result.status, result.data);
      })
      .catch(function () { /* the stream says so when she cannot be reached */ });
  }
  ["pointerdown", "keydown", "wheel"].forEach(function (type) {
    document.addEventListener(type, stillHere, { capture: true, passive: true });
  });

  function signedIn(given) {
    session = String(given);
    saidActiveAt = Date.now();
    signPassword.value = "";
    signProblem.textContent = "";
    waitingToUnlock = false;
    show("talk");
    retryMs = 1000;
    connect();
  }

  // The session is over. What was being typed stays in its box for after signing in again.
  // The questions go with it: they are for whoever is signed in, and are sent again then.
  function signedOut(words) {
    session = null;
    cancelVoiceCapture();
    dropCards();
    renderPinned(null);
    clearTracesView();
    quiet();
    enter(words);
  }

  // What to do about an answer that refuses. True when it was one of the refusals that
  // change the screen: not paired, not signed in, or nothing set on the PC yet.
  function refused(status, data) {
    if (status === 403 && data && data.need === "account") { showNoAccount(""); return true; }
    if (status === 401 && data && data.need === "sign-in") { signedOut("Sign in again to carry on."); return true; }
    if (status === 401) { unpaired(NOT_PAIRED); return true; }
    return false;
  }

  byId("sign-form").addEventListener("submit", function (event) {
    event.preventDefault();
    if (signButton.disabled) return;
    var typed = { username: signName.value, password: signPassword.value };
    // Whatever comes of it, the password does not stay in its box.
    signPassword.value = "";
    signProblem.textContent = "";
    resetNote.textContent = "";
    signButton.disabled = true;
    post("/sign-in", typed, true)
      .then(function (result) {
        if (result.status === 200 && result.data.session) { signedIn(result.data.session); return; }
        if (result.status === 403 && result.data.need === "account") { showNoAccount(""); return; }
        if (result.status === 401 && !result.data.need) { unpaired(NOT_PAIRED); return; }
        signProblem.textContent = result.data.error || "That did not work. Try again.";
      })
      .catch(function () { signProblem.textContent = NO_ANSWER; })
      .then(function () { signButton.disabled = false; });
  });

  // Asking changes nothing by itself: the person at the PC is told, and the password is
  // changed there.
  byId("reset").addEventListener("click", function () {
    resetNote.textContent = "";
    post("/reset", {}, true)
      .then(function (result) {
        if (result.status === 401 && !result.data.need) { unpaired(NOT_PAIRED); return; }
        resetNote.textContent = result.status === 202
          ? "Asked. The PC now shows that a reset was asked for from this device. Change the password there, in her Settings under Devices, then sign in here with the new one."
          : (result.data.error || "That did not work. Try again.");
      })
      .catch(function () { resetNote.textContent = NO_ANSWER; });
  });

  byId("account-check").addEventListener("click", function () {
    accountNote.textContent = "";
    ask("GET", "/account", null, true)
      .then(function (result) {
        if (result.status === 401) { unpaired(NOT_PAIRED); return; }
        if (result.status === 200 && result.data.set) { showSignIn(result.data, ""); return; }
        accountNote.textContent = result.status === 200
          ? "Not yet. Set them on the PC, then check again."
          : (result.data.error || NO_ANSWER);
      })
      .catch(function () { accountNote.textContent = NO_ANSWER; });
  });

  byId("sign-out").addEventListener("click", function () {
    // Sent while the session is still held, so the PC ends it too.
    post("/sign-out", {}, true).catch(function () { /* it ends here all the same */ });
    promptedToUnlock = true; // signing out by hand is not answered with the phone's check
    sheet.close();
    signedOut("");
  });

  // ----- the phone's own check, in the app -----
  byId("unlock").addEventListener("click", function () { signProblem.textContent = ""; unlockNow(); });

  // The app calls these. The key is only ever passed on to the PC, never kept by the page.
  window.astraNaviUnlocked = window.aiChanUnlocked = function (key) {
    if (session || !token) return;
    post("/unlock", { key: String(key) }, true)
      .then(function (result) {
        if (result.status === 200 && result.data.session) { signedIn(result.data.session); return; }
        if (result.status === 401 && !result.data.need) { unpaired(NOT_PAIRED); return; }
        if (result.status === 401) {
          // The PC no longer takes this key (the password was changed, or it was
          // switched off): the phone forgets it, and the password is asked for.
          forgetKey();
          unlockBox.hidden = true;
        }
        signProblem.textContent = result.data.error || "That did not work. Sign in with the password.";
      })
      .catch(function () { signProblem.textContent = NO_ANSWER; });
  };
  window.astraNaviUnlockFailed = window.aiChanUnlockFailed = function () {
    // Cancelled, or not recognised: the form is there, and so is the button to try again.
    if (!hasKey()) unlockBox.hidden = true;
  };
  // The app has left the foreground: whoever opens it next is asked again.
  window.astraNaviLock = window.aiChanLock = function () {
    if (!token) return;
    cancelVoiceCapture();
    if (session) post("/sign-out", {}, true).catch(function () { /* it ends here all the same */ });
    session = null;
    dropCards();
    renderPinned(null);
    clearTracesView();
    quiet();
    promptedToUnlock = false;
    waitingToUnlock = true;
    show("sign");
    noAccount.hidden = true;
    signBox.hidden = false;
    unlockBox.hidden = true;
    signPassword.value = "";
    signProblem.textContent = "";
  };
  // The app is in front again: find out how things stand, and put up the phone's check.
  window.astraNaviShown = window.aiChanShown = function () {
    if (!waitingToUnlock || session) return;
    waitingToUnlock = false;
    enter("");
  };

  var keyOnItsWay = false;
  window.astraNaviKeyKept = window.aiChanKeyKept = function (kept) {
    if (!keyOnItsWay) return;
    keyOnItsWay = false;
    unlockSwitch.disabled = false;
    if (kept === true) {
      unlockSwitch.checked = true;
      unlockNote.textContent = "On. Next time, your fingerprint or face opens her on this phone.";
      return;
    }
    // The phone could not keep it: the PC throws its half away too.
    post("/unlock-key/forget", {}, true).catch(function () { /* the key is no use without the phone's half */ });
    unlockSwitch.checked = false;
    unlockNote.textContent = "It could not be switched on. This phone goes on asking for the name and password.";
  };

  unlockSwitch.addEventListener("change", function () {
    unlockNote.textContent = "";
    if (!unlockSwitch.checked) {
      post("/unlock-key/forget", {}, true)
        .then(function (result) { if (result.status !== 200) refused(result.status, result.data); })
        .catch(function () { /* the phone's half is thrown away below, which is enough */ });
      forgetKey();
      unlockNote.textContent = "Off. This phone asks for the name and password.";
      return;
    }
    unlockSwitch.disabled = true;
    post("/unlock-key", {}, true)
      .then(function (result) {
        if (result.status === 200 && result.data.key) {
          keyOnItsWay = true;
          try { app.keepKey(String(result.data.key)); }
          catch (e) { window.aiChanKeyKept(false); }
          return;
        }
        unlockSwitch.disabled = false;
        unlockSwitch.checked = false;
        if (result.status === 403 && result.data.need === "password") {
          // Only just after the password was typed can this be switched on: a session
          // opened by the phone's check, or a while ago, cannot make a key. Still signed in.
          unlockNote.textContent = result.data.error
            || "Sign out, sign in with the password, then switch this on straight away.";
          return;
        }
        if (refused(result.status, result.data)) return;
        unlockNote.textContent = result.data.error || "That did not work. Try again.";
      })
      .catch(function () {
        unlockSwitch.disabled = false;
        unlockSwitch.checked = false;
        unlockNote.textContent = NO_ANSWER;
      });
  });

  // ----- pairing -----
  // The six digits are shown in two groups of three, the way the PC shows them.
  codeBox.addEventListener("input", function () {
    var digits = codeBox.value.replace(/\D/g, "").slice(0, 6);
    codeBox.value = digits.length > 3 ? digits.slice(0, 3) + " " + digits.slice(3) : digits;
  });

  byId("pair-form").addEventListener("submit", function (event) {
    event.preventDefault();
    problem.textContent = "";
    pairButton.disabled = true;
    post("/pair", { code: codeBox.value, name: byId("name").value }, false)
      .then(function (result) {
        if (result.status !== 200 || !result.data.token) {
          problem.textContent = result.data.error || "That did not work. Try again.";
          return;
        }
        token = String(result.data.token);
        keep(TOKEN_KEY, token);
        myName = String((result.data.device && result.data.device.name) || "");
        keep(NAME_KEY, myName);
        codeBox.value = "";
        enter("");
      })
      .catch(function () { problem.textContent = "She could not be reached. Is the PC on?"; })
      .then(function () { pairButton.disabled = false; });
  });

  // ----- offline queue & voice notes -----
  function loadOutbox() {
    try {
      var raw = stored(OUTBOX_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        outboxItems = parsed.filter(function (entry) {
          return entry && typeof entry.text === "string" && entry.text.trim().length > 0;
        }).slice(0, MAX_OUTBOX);
      } else {
        outboxItems = [];
      }
    } catch (e) {
      outboxItems = [];
    }
  }
  function saveOutbox() {
    keep(OUTBOX_KEY, outboxItems.length ? JSON.stringify(outboxItems) : null);
  }
  function renderOutbox() {
    outbox.hidden = outboxItems.length === 0;
    outboxCount.textContent = outboxItems.length === 1
      ? "1 queued message"
      : String(outboxItems.length) + " queued messages";
    outboxList.textContent = "";
    outboxItems.forEach(function (item, idx) {
      var li = document.createElement("li");
      li.className = "outbox-item";
      var label = document.createElement("span");
      label.textContent = item.text;
      var dropBtn = document.createElement("button");
      dropBtn.type = "button";
      dropBtn.className = "quiet";
      dropBtn.textContent = "Remove";
      dropBtn.addEventListener("click", function () {
        outboxItems.splice(idx, 1);
        saveOutbox();
        renderOutbox();
      });
      li.appendChild(label);
      li.appendChild(dropBtn);
      outboxList.appendChild(li);
    });
  }
  function enqueueOutbox(text) {
    var clean = String(text || "").trim();
    if (!clean) return;
    while (outboxItems.length >= MAX_OUTBOX) outboxItems.shift();
    outboxItems.push({ id: String(Date.now()) + "-" + String(outboxItems.length), text: clean });
    saveOutbox();
    renderOutbox();
  }
  function pullNativeOutbox() {
    if (!app || typeof app.takeNativeOutbox !== "function") return;
    try {
      var raw = app.takeNativeOutbox();
      if (!raw) return;
      var parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) {
        parsed.forEach(function (entry) {
          if (typeof entry === "string" && entry.trim()) enqueueOutbox(entry);
        });
      }
    } catch (e) { /* ignore malformed native queue */ }
  }
  function drainOutbox() {
    if (drainingOutbox || !token || !session || outboxItems.length === 0) return;
    drainingOutbox = true;
    function sendNext() {
      if (!token || !session || outboxItems.length === 0) {
        drainingOutbox = false;
        return;
      }
      var item = outboxItems[0];
      post("/say", { text: item.text }, true)
        .then(function (result) {
          if (result.status === 202 || result.status === 400) {
            outboxItems.shift();
            saveOutbox();
            renderOutbox();
            sendNext();
            return;
          }
          drainingOutbox = false;
          refused(result.status, result.data);
        })
        .catch(function () {
          drainingOutbox = false;
        });
    }
    sendNext();
  }
  outboxClear.addEventListener("click", function () {
    outboxItems = [];
    saveOutbox();
    renderOutbox();
  });
  loadOutbox();
  renderOutbox();

  function encodePcm16Wav(chunks, sampleRate) {
    var total = 0;
    for (var i = 0; i < chunks.length; i += 1) total += chunks[i].length;
    var mono = new Float32Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j += 1) {
      mono.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    var targetRate = 16000;
    var outLen = sampleRate === targetRate ? mono.length : Math.max(1, Math.round(mono.length * targetRate / sampleRate));
    var buf = new ArrayBuffer(44 + outLen * 2);
    var view = new DataView(buf);
    function writeStr(pos, s) {
      for (var k = 0; k < s.length; k += 1) view.setUint8(pos + k, s.charCodeAt(k));
    }
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + outLen * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, outLen * 2, true);
    var ratio = sampleRate / targetRate;
    for (var n = 0; n < outLen; n += 1) {
      var pos = n * ratio;
      var i0 = Math.min(mono.length - 1, Math.floor(pos));
      var i1 = Math.min(mono.length - 1, i0 + 1);
      var sample = mono[i0] + (mono[i1] - mono[i0]) * (pos - i0);
      var clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + n * 2, clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), true);
    }
    return new Uint8Array(buf);
  }
  function sendVoiceBytes(bytes, contentType) {
    if (!token || !session || !bytes || !bytes.length) return;
    setActivity("thinking", "Transcribing voice note");
    fetch("/voice", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "X-Session": session,
        "Content-Type": contentType || "audio/wav"
      },
      cache: "no-store",
      body: bytes
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          return { status: response.status, data: data || {} };
        });
      })
      .then(function (result) {
        setActivity("", "");
        if (refused(result.status, result.data)) return;
        if (result.status === 202) {
          toEnd();
        } else {
          add("caution", (result.data && result.data.error) || "Voice note could not be sent.", "");
        }
      })
      .catch(function () {
        setActivity("", "");
        add("caution", "Could not send voice note. Check the connection.", "");
      });
  }
  function resetVoiceButton() {
    voiceRecording = false;
    voiceHold.dataset.recording = "";
    voiceHold.textContent = "Hold";
  }
  function stopWebVoice(shouldSend) {
    var active = webAudio;
    webAudio = null;
    if (!active) return;
    try { active.proc.disconnect(); } catch (e) { /* ignore */ }
    try { active.source.disconnect(); } catch (e) { /* ignore */ }
    try { active.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    try { if (active.ctx.close) active.ctx.close(); } catch (e) { /* ignore */ }
    if (shouldSend && active.chunks.length > 0) {
      sendVoiceBytes(encodePcm16Wav(active.chunks, active.sampleRate), "audio/wav");
    }
  }
  function cancelVoiceCapture() {
    if (!voiceRecording && !webAudio) return;
    resetVoiceButton();
    if (webAudio) stopWebVoice(false);
    try { if (app && typeof app.cancelVoice === "function") app.cancelVoice(); } catch (e) { /* ignore */ }
  }
  window.astraNaviVoiceReady = window.aiChanVoiceReady = function (base64Wav) {
    resetVoiceButton();
    if (!base64Wav) return;
    try {
      var bin = atob(String(base64Wav));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      sendVoiceBytes(bytes, "audio/wav");
    } catch (e) {
      add("caution", "Voice note could not be decoded.", "");
    }
  };
  window.astraNaviVoiceError = window.aiChanVoiceError = function (msg) {
    resetVoiceButton();
    add("caution", String(msg || "Voice recording failed."), "");
  };
  function preventHoldDefault(event) {
    if (event && event.preventDefault) event.preventDefault();
  }
  voiceHold.addEventListener("contextmenu", preventHoldDefault);
  voiceHold.addEventListener("selectstart", preventHoldDefault);
  voiceHold.addEventListener("touchstart", preventHoldDefault, { passive: false });
  voiceHold.addEventListener("pointerdown", function (event) {
    if (event && event.preventDefault) event.preventDefault();
    if (event && event.pointerId != null && typeof voiceHold.setPointerCapture === "function") {
      try { voiceHold.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    }
    if (voiceRecording || !token || !session) return;
    voiceRecording = true;
    voiceHold.dataset.recording = "yes";
    voiceHold.textContent = "Release";
    if (canNativeVoice()) {
      try { app.startVoice(); } catch (e) { window.aiChanVoiceError("Could not start voice recording."); }
      return;
    }
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      window.aiChanVoiceError("Voice recording is not available on this browser.");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        if (!voiceRecording) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return;
        }
        var ctx = new AudioCtx();
        var source = ctx.createMediaStreamSource(stream);
        var proc = ctx.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        proc.onaudioprocess = function (ev) {
          if (!voiceRecording) return;
          var input = ev.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(input));
        };
        source.connect(proc);
        proc.connect(ctx.destination);
        webAudio = { ctx: ctx, stream: stream, source: source, proc: proc, chunks: chunks, sampleRate: ctx.sampleRate || 16000 };
      })
      .catch(function () {
        window.aiChanVoiceError("Microphone access was not allowed.");
      });
  });
  voiceHold.addEventListener("pointerup", function () {
    if (!voiceRecording) return;
    resetVoiceButton();
    if (canNativeVoice()) {
      try { app.stopVoice(); } catch (e) { window.aiChanVoiceError("Could not stop voice recording."); }
      return;
    }
    stopWebVoice(true);
  });
  voiceHold.addEventListener("pointercancel", cancelVoiceCapture);

  // ----- saying something -----
  function grow() {
    say.style.height = "auto";
    say.style.height = Math.min(say.scrollHeight + 5, 160) + "px";
  }
  say.addEventListener("input", grow);
  say.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      byId("say-form").requestSubmit();
    }
  });

  byId("say-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var text = say.value.trim();
    if (!text || send.disabled) return;
    if (!offline.hidden) {
      enqueueOutbox(text);
      say.value = "";
      grow();
      add("note", "Saved to outbox. Will send automatically when back in range.", "");
      return;
    }
    send.disabled = true;
    post("/say", { text: text }, true)
      .then(function (result) {
        if (refused(result.status, result.data)) {
          // Signed out, unpaired, or nothing set yet: what was typed stays in its box.
        } else if (result.status === 202) {
          say.value = "";
          grow();
          toEnd();
        } else if (result.status >= 500) {
          enqueueOutbox(text);
          say.value = "";
          grow();
          add("note", "Saved to outbox. Will send automatically when back in range.", "");
        } else {
          add("caution", result.data.error || "That did not reach her. Try again.", "");
        }
      })
      .catch(function () {
        enqueueOutbox(text);
        say.value = "";
        grow();
        add("note", "She is out of reach right now. Saved to outbox and will send automatically when reconnected.", "");
      })
      .then(function () { send.disabled = false; });
  });

  stop.addEventListener("click", function () {
    post("/stop", {}, true)
      .then(function (result) { refused(result.status, result.data); })
      .catch(function () { /* the stream will say if she is gone */ });
  });

  // A suggestion is put in the box, not sent: most of them want finishing first.
  byId("chips").addEventListener("click", function (event) {
    var chip = event.target && event.target.closest ? event.target.closest("button") : null;
    if (!chip) return;
    say.value = chip.dataset.say || chip.textContent;
    grow();
    say.focus();
    try { say.setSelectionRange(say.value.length, say.value.length); } catch (e) { /* not a text box */ }
  });

  // ----- this device -----
  menuOpen.addEventListener("click", function () {
    byId("sheet-device").textContent = (myName || "This device") + ", paired with the PC at " + location.host + ".";
    appNote.textContent = "";
    forget.dataset.sure = "";
    forget.textContent = "Forget this pairing";
    unlockSetting.hidden = !canUnlock();
    unlockSwitch.checked = hasKey();
    unlockSwitch.disabled = false;
    unlockNote.textContent = "";
    alertsSetting.hidden = !canPollAlerts();
    try {
      alertsSwitch.checked = Boolean(
        canPollAlerts() && typeof app.isAlertPollingOn === "function" && app.isAlertPollingOn() === true
      );
    } catch (e) { alertsSwitch.checked = false; }
    alertsNote.textContent = "";
    offerApp();
    if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", "");
  });
  alertsSwitch.addEventListener("change", function () {
    if (!canPollAlerts() || !token) {
      alertsSwitch.checked = false;
      return;
    }
    try {
      app.setAlertPolling(Boolean(alertsSwitch.checked), alertsSwitch.checked ? token : "");
      alertsNote.textContent = alertsSwitch.checked
        ? "On. Standing-order alerts will notify this phone in the background."
        : "Off.";
    } catch (e) {
      alertsSwitch.checked = false;
      alertsNote.textContent = "Could not update background alert polling.";
    }
  });
  byId("sheet-close").addEventListener("click", function () { sheet.close(); });
  sheet.addEventListener("click", function (event) {
    // A tap on the dimmed page behind the sheet closes it. One on the sheet's own edge
    // or padding lands on the same element, so where it fell is what tells them apart.
    if (event.target !== sheet) return;
    var box = sheet.getBoundingClientRect();
    var inside = event.clientX >= box.left && event.clientX <= box.right &&
      event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) sheet.close();
  });
  byId("app-hint-open").addEventListener("click", function () { menuOpen.click(); });

  // Asked twice, because it cannot be taken back from here.
  forget.addEventListener("click", function () {
    if (forget.dataset.sure !== "yes") {
      forget.dataset.sure = "yes";
      forget.textContent = "Tap again to forget it";
      return;
    }
    sheet.close();
    unpaired("This device has forgotten its pairing. The PC still lists it until you remove it in her Settings.");
  });

  byId("app-download").addEventListener("click", function () {
    appNote.textContent = "";
    post("/app-pass", {}, true)
      .then(function (result) {
        if (refused(result.status, result.data)) return;
        if (result.status !== 200 || !result.data.path) {
          appNote.textContent = result.data.error || "The app could not be fetched just now.";
          return;
        }
        appNote.textContent = "Downloading. Open the file when it is done; the phone will ask once whether this browser may install apps.";
        location.href = String(result.data.path);
      })
      .catch(function () { appNote.textContent = "She could not be reached. Is the PC on?"; });
  });

  byId("app-open").addEventListener("click", function () {
    appNote.textContent = "";
    post("/handover", {}, true)
      .then(function (result) {
        var data = result.data;
        if (refused(result.status, data)) return;
        if (result.status !== 200 || !data.code || !data.at || !data.fingerprint) {
          appNote.textContent = data.error || "That did not work. Try again.";
          return;
        }
        var target = "astranavi://station?at=" + encodeURIComponent(String(data.at)) +
          "&fp=" + encodeURIComponent(String(data.fingerprint)) +
          "&code=" + encodeURIComponent(String(data.code));
        // Some browsers only follow a link to another app when it is tapped directly, so
        // the link is also put on the page. It works once, for two minutes.
        var tap = document.createElement("a");
        tap.href = target;
        tap.textContent = "Tap here if the app did not open.";
        appNote.textContent = "Once the app opens it has taken over this pairing, and this browser page is no longer needed. If the app is not installed yet, do step 1 first. ";
        appNote.appendChild(tap);
        location.href = target;
      })
      .catch(function () { appNote.textContent = "She could not be reached. Is the PC on?"; });
  });

  byId("app-later").addEventListener("click", function () {
    keep(APP_KEY, "later");
    offerApp();
    sheet.close();
  });

  steerForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = steerInput.value.trim();
    if (!text || !pinnedId || steerSend.disabled) return;
    steerSend.disabled = true;
    pinnedNote.textContent = "";
    post("/mission/steer", { missionId: pinnedId, note: text }, true)
      .then(function (result) {
        if (refused(result.status, result.data)) return;
        if (result.status === 200 && result.data.mission) {
          steerInput.value = "";
          renderPinned(result.data.mission);
          pinnedNote.textContent = "Note added.";
        } else {
          pinnedNote.textContent = result.data.error || "Could not add note.";
        }
      })
      .catch(function () { pinnedNote.textContent = NO_ANSWER; })
      .then(function () { steerSend.disabled = false; });
  });

  pinnedStop.addEventListener("click", function () {
    if (!pinnedId) return;
    if (pinnedStop.dataset.sure !== "yes") {
      pinnedStop.dataset.sure = "yes";
      pinnedStop.textContent = "Tap again to stop mission";
      return;
    }
    pinnedStop.disabled = true;
    pinnedNote.textContent = "";
    post("/mission/stop", { missionId: pinnedId }, true)
      .then(function (result) {
        if (refused(result.status, result.data)) return;
        pinnedNote.textContent = result.status === 200
          ? "Mission stopped."
          : (result.data.error || "Could not stop mission.");
      })
      .catch(function () { pinnedNote.textContent = NO_ANSWER; })
      .then(function () {
        pinnedStop.disabled = false;
        pinnedStop.dataset.sure = "";
        pinnedStop.textContent = "Stop mission";
      });
  });

  traceDrawer.addEventListener("toggle", function () {
    if (traceDrawer.open) loadTraces();
  });
  traceRefresh.addEventListener("click", loadTraces);

  document.addEventListener("visibilitychange", function () {
    // A phone puts a sleeping page's connection down; pick it up again when looked at.
    if (!document.hidden && token && session && link.dataset.state === "lost") { retryMs = 1000; connect(); }
    // Back in front after the app locked: the same as the app saying so itself.
    if (!document.hidden) window.aiChanShown();
    // A card that came while nobody was looking is new to whoever looks now.
    if (!document.hidden) restCards();
  });
  // The keyboard coming up makes the page shorter: keep the newest message in view.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { if (stick) toEnd(); });
  }

  // Opened by the app from a handover link or QR pairing code: the code in the
  // address is traded for a token of the device's own, and is not left in the address.
  var carried = /^#pair=([A-Za-z0-9_-]{6,64})$/.exec(location.hash);
  if (carried) {
    try { history.replaceState(null, "", "/"); } catch (e) { location.hash = ""; }
    var deviceHint = /Android/i.test(navigator.userAgent || "") ? "Android Phone" : "Phone";
    post("/pair", { code: carried[1], name: deviceHint }, false)
      .then(function (result) {
        if (result.status === 200 && result.data.token) {
          token = String(result.data.token);
          keep(TOKEN_KEY, token);
        }
      })
      .catch(function () { /* falls through to whatever this device already has */ })
      .then(function () {
        if (token) enter("");
        else { show("pair"); problem.textContent = "The pairing could not be carried over. Pair with a code from the PC instead."; }
      });
  } else if (token) { enter(""); } else { show("pair"); }

  if (document.head) {
    [["manifest", "/manifest.webmanifest"], ["apple-touch-icon", "/apple-touch-icon.png"]].forEach(function (pair) {
      var el = document.createElement("link");
      el.setAttribute("rel", pair[0]);
      el.setAttribute("href", pair[1]);
      document.head.appendChild(el);
    });
  }
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }
})();
`;
