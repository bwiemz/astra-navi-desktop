# AI-chan Desktop

A local-first desktop companion who stands in the corner of your screen and acts as your PC's own AI. She talks with you by text or voice, remembers and learns, looks things up, sees your screen when you ask, works your desktop (windows, music, volume, clipboard), manages reminders/missions/agendas, runs research in the background while you carry on, and keeps an inspectable record of everything she does.

Everything runs on your own computer. There is no account to create, no subscription, and no required cloud API key. The language model, speech recognition, embeddings, and local voices run directly on your hardware.

- **Codebase & Evaluation Suite:** Open-source under the **[MIT License](LICENSE)**
- **Security Architecture & Audits:** Documented in **[SECURITY.md](SECURITY.md)** (`npm run eval -- --fuzz` & `npm run eval -- --audit`)
- **Default 3D Character & BYO-MMD:** Ships with **Astra Navi** (`assets/models/ai-navigator/`, CC-BY-4.0 / MIT) plus full Bring-Your-Own MMD (`.pmx` / encrypted bundle) support — see **[NOTICE.md](NOTICE.md)**
- **Cross-Platform Contributions:** Uses a strict `PlatformAdapter` boundary (`src/core/platform/adapter.ts`); Windows and macOS contributors welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**

## What you need

- **Linux with KDE Plasma on Wayland** is the primary tested desktop target (other Linux desktops run it as an ordinary window without Wayland layer-surface placement; initial **Windows** `PlatformAdapter` scaffolding lives in `src/core/platform/windows.ts`, and macOS contributions are welcome).
- **Node.js 24 or newer.**
- **A graphics card helps a lot.** With about 7 GB of graphics memory she answers in a few seconds. Without one she still works, on the small model and more slowly.
- **Disk space:** 3 to 6 GB for her brain, depending on the size picked for your computer, plus about 0.5 GB for speech. The optional designed voices add about 9 GB.
- **Optional system helpers for senses and hands** (she reports what is present on self-check): `spectacle` and `tesseract` (screen reading), `fd` and `ripgrep` (file search), `pdftotext` and LibreOffice (documents), `wpctl` (volume).
- **3D Character (`Astra Navi` included, or BYO-MMD):** An original futuristic chibi navigator (**Astra Navi**, built in Blender with 95 bones, Foot/Toe IK, twist bones, 30 articulated finger bones, hair/skirt physics, and 25 morphs) is bundled out of the box. You can also import your own `.pmx` model folder at any time — just follow that model's license terms.

## Set up

```sh
npm install
npm start
```

To put her in your Linux application menu:

```sh
npm run install-launcher
```

**AI-chan Desktop** then appears in your launcher (`npm run install-launcher -- --remove` removes it). To start automatically at login, toggle **Start when I log in** in the tray menu.

Astra Navi loads immediately out of the box. To switch to another MMD character you own, open the tray menu, choose **Import character model…**, and select its `.pmx` file, or run:

```sh
npm run import-model -- "/path/to/model.pmx"
```

Importing packs third-party `.pmx` models and textures into a per-machine encrypted container in `~/.local/share/ai-chan/` without modifying your source files.

The first message you send downloads her language model while the speech bubble displays progress. Switching on the microphone downloads the speech recognition model the same way.

## Using it

- **Click her** to open the message box. Press Enter to send, Escape to stop a reply or close the box. You can type the next message while she is still answering; it waits its turn.
- **Click the microphone** beside her feet to talk. She listens until you click it again. When you stop speaking she answers aloud, and you can talk over her to interrupt.
- **Or just say her name.** Tick **Listen for her name (microphone always on)** in the tray menu: say "Hey AI-chan" and she wakes up, or ask a question in one breath. Everything not addressed to her is transcribed locally and immediately discarded.
- **Drag the stand under her feet** to move her.
- **Tray icon:** talk, settings, show or hide, choose brain size, language, voice, do-not-disturb, morning briefing, always-listen wake word, start at login, conversation history, import/switch character model, or quit.

Ask for what you want in plain words: "find me a good free DAW and install it", "open Dolphin", "write up these notes as a Word document", "trim the first ten seconds off this clip". She states what she plans to run, and the permission layer asks you before anything that modifies your system.

### Your PC & Fleet

- **System telemetry.** Ask "how's the ship?" or "why is it slow?" and she inspects CPU, memory, disks, GPU, temperatures, and top processes. A background watch warns if disk, memory, or thermals cross safe thresholds.
- **She speaks first, sparingly.** The first time you start her each day she gives a short briefing: anything wrong, one line on the ship, today's reminders, updates waiting. She holds it back if do-not-disturb is on or the graphics card is already busy with a game or a render, and tries again at the next start. After that she only speaks unprompted for a reminder that is due, a job that finished, or a real problem. **Do not disturb** in the tray holds everything you did not ask for and gives you one summary when you switch it off; reminders and jobs you started still come through.
- **She follows through.** "Remind me at six", "set a timer for twenty minutes": these are real and survive a restart. "Render this and tell me when it's done": she starts the job in the background, keeps talking, and reports the result when it ends, including a failure. While she is reporting something that happened she has no tools, so nothing in a program's output can make her act.
- **She knows what is on.** "What's on today?", "when is my next meeting?", "put the dentist down for Tuesday at three": she keeps an agenda. Point her at calendars of yours in Settings (a calendar file on this PC, or the private iCal/ICS address your calendar service gives out for sharing) and she reads them; she never changes them, and no account or sign-in is involved. A feed is asked at most every fifteen minutes and its address is kept only in her settings file on this PC. Things you ask her to put down go on a short list of her own. Today's entries are part of the morning briefing, and she says so a quarter of an hour before something with a time starts (that warning can be changed or switched off). What a calendar says may have been written by whoever sent an invitation, so she treats it as information and asks you before adding or removing anything once she has read one. She would sooner leave an entry out than show it on the wrong day: a kind of repeat she cannot work out exactly (every Nth week of the year, say), or a time zone she has never heard of, is left out and the calendar is named as not fully read. A `webcal://` address is taken as the same address over https. If a feed cannot be reached she shows the last copy she read and says how old it is.
- **She keeps watch for you.** "Tell me when the render folder has the final file", "tell me if the NAS stops answering", "let me know when the service is back": she sets a standing order, which is one check that is run again every few minutes without her, and she speaks up when what it finds comes true. A standing order can only look: on this PC the check must be a plain read-only command with no wildcards, variables or chaining; on another machine it must be one of the plain status commands; or it is a web address, of which she learns only whether it answered. You are asked before one starts, with the exact check and how often. It ends when it has told you (unless you asked to be told every time) or after a week, and "what are you watching?" lists them and lets you cancel one. They survive a restart.
- **She carries a mission through.** "Update the server tonight, check it came back, then clear the old logs": she plans it as steps, one command each, on this PC or on a machine of yours, and shows you the whole plan before she takes it on. After that it goes on by itself, also while she is closed and started again: what stands where is written down after every step. A step that only looks runs; a step that changes something waits for your yes with its exact command in front of you, at the PC or on a signed-in phone, for as long as it takes. A yes is a yes to exactly what you were shown: before every run, also a second try and after a restart, the step is looked at again, and if its command, its machine or that machine's address is no longer what you approved (or she has been closed and started since), you are asked again. A yes given on a phone does not cover a step that has come to touch a place where passwords or keys are kept; that one is asked at the PC. A plan with a step she would never be allowed is not taken on at all, so that it cannot stop half done. A step that fails is tried again as often as the plan said and then the mission stops and she tells you why, with the last few lines the command printed, marked as a program's words; you can have it taken up again at that step, which she asks you about at the PC every time, or stopped. Her record of what she did says for each step where the yes was given. If she was closed while a step was running, nobody knows how far it got, so the mission stops there and asks: she never runs a half-done command again by herself. A mission holds while a game has the graphics card, and can be set to begin later. Up to twelve steps, each one line.
- **She knows when you are in a game, and keeps quiet.** Every half minute she asks the graphics card whether a game has it. While one does, what she would bring up by herself (a problem she noticed, updates waiting, the day's briefing) is held, and told as one thing when the game is over; if nothing came up she says nothing. Things you asked for, such as a reminder, a finished job or a standing order's news, still reach you at once, but as a plain notice in her balloon and a desktop notification, so that her brain is not loaded onto the card your game is using. If you are talking to her in the middle of a game she tells them herself as usual. She also keeps a play log (which game, from when to when; sixty days, on this computer only, in `play-log.json` beside her other records), so "how long have I been playing today?" has an answer. She does not bring up how long you have played unless you ask. **Stay quiet while a game is running** in Settings turns the quiet off; the play log is kept either way. Games are recognised on NVIDIA cards only.
- **She does not get to claim things she did not do.** After any reply that says something was done or promises it for later, the app checks that a tool which does such things actually ran. If she said "timer set" without setting one, she is made to actually do it, and if she still does not, a note under her reply tells you nothing was done. The same goes for looking: if she says she checked the volume, your windows or the weather, or worked out a sum, in a reply in which she used no tool, she is made to look properly and to say her first answer was not checked. When you plainly asked for one of her actions, or she plainly says she looked, the app decides this by rule; in less clear cases it asks the model for a second opinion, which the small brain gives unreliably. A step you said no to is never tried again on her own say-so: you get the note instead.
- **She keeps a Deck Log.** One dated line for each thing the two of you finish, in `~/Documents/AI-chan/deck-log.md`.
- **She has her own browser.** Web searches run in a real browser window that she operates. It says honestly what it is, keeps nothing between runs, cannot download, and cannot reach your own computer or network. If a site asks for proof that a person is there, the window is shown to you to answer; she does not try to get around it.
- **She knows things.** Lookups go to places that publish an interface for programs and need no account: Wikipedia, DuckDuckGo's instant answers, Stack Overflow, the Arch wiki, Hacker News. She turns your question into key words for them, which is what such sources match on. Her background research can follow the links on a page to reach its sources; in conversation she asks before opening a link a page offered. Sums, percentages, unit conversions and date sums go to an exact calculator, never her head. Weather comes from Open-Meteo. She reads PDFs, office documents, spreadsheets and the text in pictures, and finds your files by name or by what is in them.
- **She can see.** "Look at this" makes her take a picture of the screen and read it: a small vision model describes the scene and a text reader picks out the words. She asks first every time unless you switch that off, the picture is deleted as soon as it is read, and nothing leaves the computer. She also knows which windows are open and which one you are in.
- **She has hands on the desktop.** Bring a window forward, minimize or close it; pause, skip, and say what is playing; set the volume; read what you copied or copy something for you to paste; lock the screen.
- **She works alone.** Hand her a question that needs digging ("research the options for…") and a second copy of her mind searches, reads and writes a report in the background while you keep talking. It checks its own draft, lists what it could not confirm, and saves the report in `~/Documents/AI-chan/reports`. It can only look things up; it cannot touch the PC.
- **She looks back.** Past conversations are kept word for word on this computer, and "what did we decide about that last week?" searches them. You can turn this off or erase it in Settings.
- **She notices habits.** When you have asked for the same thing at about the same time on three different days, she mentions it once and offers a daily reminder.
- **She has a body.** She waves hello, leans in while you speak, tilts her head to think, bounces when excited, and shakes her head when something went wrong. When her brain is put away after a quiet spell she falls asleep on her feet, and wakes with a start when you speak. She is drawn only as often as needed: sixty frames a second while something is happening, twenty while idle, six asleep, none while hidden.
- **She knows herself.** "How are you doing?" runs a self-check of her brain, voice, hearing, eyes, hands, lookups and memory, and how much disk space she takes. She will tell you when something she keeps but does not use could be cleared out (brain models other than the one in use, the model that designs new voices), and does it only after you confirm.
- **Her hands can be taken off the controls.** **Hands off the controls** in the tray stops whatever she is doing and leaves her able only to talk and look things up, until you switch it back. **What she has done…** opens the full record of every tool she has used, what was asked first, and what you refused.
- **She can wait for her name.** With **Only answer to her name** on, the microphone ignores anything that does not start with "AI-chan" (or 愛ちゃん / 爱酱), so the television does not set her off. For 25 seconds after she speaks you can reply without saying it again.

### Beyond her window

Four things take her past her own corner of the screen. Each has its own switch, in **Settings…** and in the tray menu, and each is off until you switch it on.

- **She can work inside other programs.** With **She may work inside other programs** on, ask her to "press play in Elisa", "open the Find bar in Kate and search for…", "set the calculator to hex". She reads the window's buttons, menus and fields by name through the desktop's accessibility service, presses them and fills them in, and checks the result after each step. A control is pressed only on its whole name, never on a near match. For programs that describe nothing (games, some older programs) she looks at the screen, clicks on words she can see, types and presses keys through a virtual pointer and keyboard that exist only while she is working. You are asked before she works in a program; "for this chat" lets her carry on in that one program, and anything that reads like deleting, sending, paying, saving or confirming is still shown to you step by step, as is every step in a browser, a mail or chat program, or system settings, and anything she types into a program that could run it (an editor with a terminal panel). She never touches password managers, private or sign-in windows, windows where the system asks for a password or permission, a terminal's keyboard, or her own windows.
- **She can keep an eye on the screen.** With **Keep an eye on the screen** on, the window manager tells her each time the window in front changes. She then knows which program and window you are in and for how long, can answer "what was I doing an hour ago?", and reads small windows as they pop up so she can speak up when one of them is an error or a crash. A full window she still only reads when you ask her to look. What she takes in this way is held in memory and not written anywhere, with one exception: when she speaks up about a window, the line she quotes becomes part of the conversation, which is kept like any other. Password managers, private browsing, sign-in windows, chat and mail programs and full-screen programs are not read; of those she knows the program's name and nothing more, and for private windows not even the title. You can add programs she must never read.
- **She can remember what the PC just played.** With **Remember what the PC just played** on, she holds the last minute and a half of the computer's sound in memory. "What did he just say?" or "translate that last line" turns it into words, in whatever language it was in. It is never written to disk. A voice call playing through the speakers is heard too, so leave it off if that matters.
- **Your other devices can talk to her.** With **Let my other devices talk to her** on, she serves a small page on your home network. Open the address shown in Settings on your phone or laptop, type the six-digit pairing code from the PC, and you can talk to her from the sofa: ask things, set reminders, see her answers arrive. The connection is encrypted with a certificate she makes herself (your browser will warn about it once; Settings shows its fingerprint so you can check it is hers). A device from outside your home network is refused. From another device she does only what needs no approval: anything that would put a question on the PC's screen is refused, and so is looking at the screen or listening to the PC. There is one kind of question a device can answer: when a mission she is carrying out reaches a step that needs your yes, the step is shown on your signed-in devices as well as on the PC, with the machine it runs on and the exact command, and you can allow or refuse it there. Any device that is signed in can answer. One you have not used for half an hour, or whose page or app was closed, has to sign in again first, and signing in answers nothing by itself. A step that touches a place where passwords or keys are kept is asked at the PC only, and so is everything she asks about in a conversation. A device sees its own conversation with her and the things she brings up herself, such as a reminder coming due; it is not shown the conversation held at the PC, though she remembers that conversation like anything else and can be asked about it. The PC shows what was asked from afar. Devices can be removed in Settings at any time.

  **A paired device still has to sign in.** Pairing says the device is yours; signing in says it is you holding it. In Settings, under **Signing in on your devices**, set a name and a password. Until you do, a paired device can do nothing. After that her page asks for them every time it is opened, and so does the phone app. They are set and changed only at the PC, and changing them signs every device out. Five wrong tries make that device wait ten minutes. A device can ask for a reset: that puts a notice on the PC naming the device, shows it in Settings, and changes nothing else. If it was you, set a new password in Settings; if it was not, remove that device. A device is signed out when you have not used it for 30 minutes (a page merely left open does not count as use), when its page or app is closed, after 12 hours at the latest, and whenever she is restarted. The password itself is never kept: only a scrambled form of it that cannot be turned back, in a file that only your account on the PC can read.

She can also **read desktop notifications**, with a switch in Settings only: **She may read desktop notifications**, off until you turn it on. While it is on she listens for the notifications programs put up and keeps the last thirty in memory, so "what was that notification?" and "did I miss anything?" get an answer: which program, the headline and the first lines. The list is never written to disk, to her notes or to her record, and switching it off lets go of all of it. Once she has told you what they said, both the list she was given and her own words about them are taken out of the conversation she holds in mind, leaving only a note that they were read; so they are not in the conversation saved for the next launch, not in the word-for-word record of past conversations, and not in any summary she makes to save room. Ask a follow-up and she looks again. Notifications from password managers, wallets and sign-in prompts are never read, only counted, and **Never read notifications from** adds programs of your own to that list. A notification is somebody else's words, so once she has read some, saving a note or a reminder in that conversation asks you first, like after a web page. Asked from another device, she refuses, as she does for the screen. This has been tested piece by piece (the listening, the list, the rules) but not yet seen working with her brain.

**There is an Android app for the station.** It is a small window onto the same page: it remembers where she is, so there is no address to type, and it trusts exactly one certificate, hers, so there is no browser warning (and it refuses to open at all if something else answers at her address). It is built on your own computer and handed to a phone that is already paired:

```sh
scripts/setup-android.sh   # once: fetches a Java kit and Google's Android build tools (about 620 MB)
scripts/build-android.sh   # builds phone-app/build/ai-chan.apk, signed with a key made on this PC
```

Restart AI-chan, open her page in the phone's browser, and a panel offers the app: **Download the app** (the phone asks once whether the browser may install apps, and may say the developer is unknown, which is true: it is you), then **Open it, paired**, which moves the browser's pairing into the app. Running the first script accepts Google's Android SDK licence. The app asks for network access and for the phone's fingerprint or face check, nothing else; it holds no character art and no model, and is as free and unofficial as the rest. There is no iPhone app; an iPhone keeps using the browser.

**Every time the app is opened, it asks who is holding the phone.** The first time that is the name and password you set on the PC. Within five minutes of signing in with the password you can switch on **Unlock with fingerprint or face on this phone** in the page's menu (later than that, she asks you to sign out and in again first, so that a phone left signed in cannot be used to switch it on), and from then on the phone's own check opens her; the password still works, and "Use the password" on the check goes back to it. Leaving the app, even for a moment, signs it out, so whoever opens it next is asked again. What the phone keeps for this is not your password: it is a key the PC hands out for that one phone, sealed in the phone's keystore so that it can only be read straight after a fingerprint or face check. Adding a new fingerprint or face to the phone makes that key unreadable for good, by design, and the app asks for the password once more; so does changing the password on the PC, switching the setting off, pointing the app at a different PC, or moving the pairing from the browser to the app. The app's window is also kept out of screenshots and out of the picture in the list of recent apps. This part of the app has been built and inspected but not run on a phone.

She can also **reach your phone**, with no switch of its own: if KDE Connect is installed and your phone is paired with it, she can ring the phone to find it and send it a link, some text or a file. Passing reminders on to it is a setting.

### Her other machines

Your PC is her ship; a server or a NAS can be the rest of the fleet. Under **Your other machines** in Settings you add one by its name, address and the account to sign in as. Then:

1. **You confirm it is the right machine.** She shows the machine's own fingerprints; compare them with what the machine says about itself (the panel gives the command to run there). From then on she will not talk to anything else answering at that address.
2. **You let her key in.** She makes a key pair for that machine alone. Either type the machine's password into the password window your desktop opens (it goes straight to SSH; she never sees it and it is not stored), or copy her public key and add it to the machine by hand.
3. **She can work there.** "How is proxmox doing?", "which containers are running on the NAS?", "fetch last night's backup log", "restart the plex container". She connects with her own key and none of your personal SSH settings, keys or agents.

Every command she wants to run on another machine is shown to you first, with the machine and the account named, because there she is often the administrator. The one exception is a short, fixed list of status checks (uptime, disk and memory use, what is running, pool health), alone or up to five of them in one line, on machines where you have ticked **She may check its status without asking**. Reading a file there asks too (the same tick covers a handful of status files such as `/etc/os-release` and `/proc/loadavg`, and nothing else). Writing, sending and fetching files always ask; what she would write is shown to you in full, so anything longer than 4,000 characters she has to save here first and send as a file. Files are replaced in one move, so a dropped connection leaves the old file whole. The machine you are shown is the machine that is used: if it is changed or removed while a question is open, nothing is done. From your phone she will only do the status checks. **Hands off the controls** stops her changing anything there too. **Forget** deletes her key and takes it off the machine's own list. She is told what your machines are called, so "how is proxmox doing?" is understood as a question about that machine; ask by the name you gave it. When you say no to a step, she does not come back with another way of doing the same thing in that reply.

**Before she changes a file there, she keeps the old one.** When she writes or sends a file over one that exists, the machine first copies the old file into `~/.ai-chan-backups` in the account she signs in as (readable by that account only), and the new file keeps the old one's owner and permissions. If that copy cannot be made, nothing is written. The question you are asked shows what would change, line by line, because she looks at the file first; that look is for your eyes, and is not handed to her. "Put it back" (her `restore`) returns a file to how it was, after asking, and keeps what it replaces, so putting back can be undone too. The twenty newest copies are kept. After a command that starts, stops or restarts a service, she checks there and then whether it is running and is told the answer. This covers files she writes or sends herself; what a command you approve does to a machine is not undone by it.

The account she signs in as may use any shell; what she sends is put so that bash, fish and the rest all read it the same way. She uses SSH for everything, including files. Plain FTP is not offered: it sends passwords and files unencrypted.

### What she may do without asking

| Goes ahead on its own                                               | Asks you first                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Searching the web                                                   | Any command that is not on a short list of look-only commands with known options                                         |
| Reading a web page that you named or that a search returned         | Every install, and anything using `pkexec`                                                                               |
| Commands that only look: `ls`, `df`, `pacman -Q`, `ffprobe`, …      | Commands that use wildcards, variables or redirection                                                                    |
| Reading an ordinary file                                            | Creating or changing files outside her own folder                                                                        |
| Creating and editing files in her own folder `~/Documents/AI-chan`  | Opening any other web address, a local file, or an address on this computer or network                                   |
| Finding and starting installed applications                         | Saving a note, a reminder or a log line once she has read a web page, a file or a program's output in this conversation  |
| Saving and searching her own memory                                 | Anything that touches passwords, keys, browser data or chat apps                                                         |
| Checking the ship's status, setting reminders, writing the Deck Log | A background job, on the same terms as the same command run directly                                                     |
| Listing reminders and standing orders                               | Starting a standing order, shown with the exact check she will repeat                                                    |
| A mission's step that only looks                                    | Taking on a mission, shown as its whole plan; and each of its steps that changes something, again, when she reaches it   |
| Reading the agenda; adding to or removing from her own list         | Adding to or removing from her own list once she has read a calendar, a web page or a file                               |
| Reading recent desktop notifications, once you switched that on     | Reading them when asked from another device (refused: nobody is at the PC to say yes)                                    |
| Sums, weather, a self-check, finding files in your home folder      | Looking at your screen (unless you have said she need not ask)                                                           |
| Listing windows, bringing one forward, minimizing                   | Closing a window                                                                                                         |
| Music controls and volume (never above 100%), locking the screen    | Reading your clipboard; writing to it once she has read outside text                                                     |
| Starting background research, before she has read outside text      | Deleting models that are not in use                                                                                      |
| Hearing back what the PC played (once you have switched that on)    | Reading another program's controls (unless she may look without asking)                                                  |
| Ringing your phone, sending it something before outside text        | Working inside another program: once per program, and every step that reads like deleting, sending, saving or confirming |
| From a paired device: only what is in this column                   | Typing or pressing keys in another program once she has read outside text; every step in a browser, mail or chat app     |
| Status checks on another machine where you ticked the box           | Every other command on another machine; reading any other file there; writing, sending, fetching                         |

Requests in the last row are shown in red and can only be allowed once, never "for this chat". The same goes for anything that sweeps across your whole home folder or prints your environment variables. "Allow for this chat" is only offered for an exact command with nothing left to chance in it.

Installs that need administrator rights go through `pkexec`, so you type your password into your desktop's own prompt. The app never sees it.

**She reads web pages, and a page can try to trick an assistant.** The rules above are there for that: a page cannot get her to change your system, change your files, read your private data, send something to an address of its choosing, or plant a note in her memory without a question appearing on your screen that shows exactly what would happen. Read those questions. If a request looks unrelated to what you asked for, say no.

### Her brain

She thinks with an open-weight language model that runs on your computer. The tray's **Her brain** menu has three sizes:

| Size     | Model       | Download | Graphics memory | What to expect                                                                   |
| -------- | ----------- | -------- | --------------- | -------------------------------------------------------------------------------- |
| Small    | Qwen3.5 4B  | 2.7 GB   | about 4 GB      | Fine for chat and simple tasks. More likely to get a detail wrong.               |
| Standard | Qwen3.5 9B  | 5.7 GB   | about 7 GB      | The default when your card can hold it. Answers in a few seconds.                |
| Large    | Qwen3.8 27B | 16.6 GB  | about 19 GB     | Better judgement on multi-step tasks. Slower, and it takes most of a large card. |

**Choose for this computer** picks Standard or Small. Large is never picked for you.

After ten minutes without a message she lets go of the model's memory so games and other programs can have it, and takes about three seconds to wake up on your next message. The conversation is kept.

While a game has the graphics card she does not wait the ten minutes: she lets go a minute after each reply, and her designed voice with her, so the memory is only hers while you are actually talking to her. The badge beside her says which game she made room for. With **Choose for this computer**, she also takes the Small brain when the Standard one no longer fits beside what is already on the card, as long as Small is already downloaded. **Give the graphics card back while a game is running** in Settings turns both off.

**Use less graphics memory (experimental)** in Settings holds the conversation more compactly. It is off by default, applies only to the three brains above, and reloads her brain when changed.

Asked how she is doing, her self-check also says how full her working memory is. When a long conversation fills it, old tool results are shortened and the oldest part is folded into a short summary, instead of the start of the conversation being dropped.

A small local model is not as capable as the large hosted ones. She holds a conversation, gives opinions, and handles tasks of a few steps well. On long, fiddly jobs she can lose the thread or state something that is not so. The approval questions show you exactly what she is about to run, whatever she says about it.

Advanced: `brain` in the settings file also accepts the full path of any GGUF model file.

### Her voice and language

**Her language** in the tray menu switches her between English, Japanese (日本語) and Chinese (中文). She then replies, listens and speaks in that language. The menus and approval questions stay in English for now.

She has two kinds of voice, chosen under **Her voice**:

| Voice                                | Languages    | Needs                                                                        |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------- |
| Designed voices (ten to choose from) | All of them  | An NVIDIA graphics card and a one-time set-up (below)                        |
| Light                                | English only | Nothing. Runs on any computer, and is what she uses until the set-up is done |

The designed voices are high, bright, energetic character voices. Each was invented by the Qwen3-TTS speech model from a written description, so they are original synthetic voices, not copies of the character's voice actresses. Pick one in the menu and she says a line in it, so you can choose by ear. Sweet and Bright are the highest and the most girlish. Vega, Nova, Melody, Lumi, Aria and Stella were described as grown women with the same brightness, from highest to lowest pitch; try those if Sweet sounds too young. You can also design your own: see [assets/voice/README.md](assets/voice/README.md).

To set up the designed voices (about 6 GB, plus 2.5 GB the first time she speaks):

```sh
npm run setup-voice
```

This needs [`uv`](https://docs.astral.sh/uv/). With a designed voice a sentence takes two to three seconds to start. The light voice starts in about one second but only speaks English, so in Japanese or Chinese without the set-up her replies are text only.

Listening, recognition and speech all happen on your computer; no audio leaves it. English recognition is fast; Japanese and Chinese use a larger recogniser and take a second or two longer.

### Memory

She remembers across conversations, and she learns from them.

- **Facts about you.** Your name, how you like things, what you are working on. She saves these when you tell her, and picks up ones she missed afterwards.
- **What you talk about.** When a conversation has gone quiet for a few minutes she writes it up: each real topic gets a note with its key points (what you said, what was decided, what she recommended). The next time the topic comes back, in any words, that note is put in front of her before she answers, so she carries on from where you left off. A topic you return to often collects more points.
- **What you ask her to do.** Each kind of task she carries out with her tools gets a note with the steps that worked, and a count. The next time you ask for the same kind of thing she is handed those steps and follows them, and after doing it she rewrites the note with what worked best. Tasks you ask for often are the ones she gets quickest and most reliable at.

Notes are found by meaning, not by matching words (a small model for this, about 120 MB, downloads by itself the first time she starts): "cut the start off this clip" finds her note on "Trim a video", and a question in Japanese finds a note written in English.

**You can see and change all of it.** **What she has learned…** in the tray menu opens a readable page of everything, each note with a short code. Tell her "forget" and the code, or what the note is about, and she deletes it. The notes themselves are in `~/.local/share/ai-chan/memory.json`, a plain file you can edit or delete while the app is closed. Nothing is uploaded.

**What she will not learn from.** Notes written by herself are saved without asking you, so they are built only from your own words, plus her own replies and actions when nothing from outside was in the conversation. Once she has read a web page, a file or a program's output in a conversation, her write-up of it uses only what you said and the actions you approved. A page cannot plant something in her memory this way.

Writing up takes a few seconds of the graphics card, only happens while her brain is already loaded, and stops at once if you start talking. The current conversation is in `conversation.json` and is picked up again when you restart; **Start a new conversation** in the tray clears that thread and keeps everything she has learned.

### Settings

**Settings…** in the tray menu opens a panel for everything most people will want to change, and changes take effect at once. The same settings live in `~/.local/share/ai-chan/config.json`; a few rarely needed ones are only there, and need a restart.

| Setting                    | Default          | Meaning                                                                                                                              |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `brain`                    | `auto`           | `auto`, `small`, `standard`, `large`, or a path to a GGUF file                                                                       |
| `contextSize`              | `16384`          | How much conversation she holds in mind, in tokens                                                                                   |
| `thinkingTokens`           | `256`            | How long she may think before answering. `0` answers at once                                                                         |
| `idleUnloadMinutes`        | `10`             | Minutes of quiet before she frees the model's memory. `0` never does                                                                 |
| `yieldToGames`             | `true`           | With a game on the graphics card, free the model's memory a minute after each reply; on `auto`, use Small when Standard does not fit |
| `quietInGames`             | `true`           | With a game running, hold what she would bring up herself until it ends, and show reminders as plain notices without waking her      |
| `leanMemory`               | `false`          | Hold the conversation in less graphics memory. Experimental; only for the three built-in brains                                      |
| `fittingTools`             | `false`          | Offer her a core of tools and the ones each message looks to need, not all of them every time. Experimental; see below               |
| `keepTraces`               | `false`          | Write the record of each reply to `traces.jsonl` in her data folder. See "Why did she do that?" below                                |
| `language`                 | `en`             | `en`, `ja` or `zh`                                                                                                                   |
| `voice.engine`             | `auto`           | `auto`, `full` (designed voices) or `light`                                                                                          |
| `voice.design`             | `perky`          | Which designed voice: a file name in `assets/voice`                                                                                  |
| `voice.name`               | `af_heart`       | Which built-in voice the light engine uses                                                                                           |
| `voice.speed`              | `1.05`           | Speaking speed                                                                                                                       |
| `voice.speak`              | `when-spoken-to` | `when-spoken-to`, `always` or `never`                                                                                                |
| `voice.needsName`          | `false`          | With the microphone on, only answer speech that starts with her name                                                                 |
| `voice.alwaysListening`    | `false`          | Microphone on from the start; she answers only to her name                                                                           |
| `voice.otherNames`         | `[]`             | Extra names she answers to, such as `["Computer"]`                                                                                   |
| `sight.withoutAsking`      | `false`          | She may look at the screen without asking each time                                                                                  |
| `hands.inPrograms`         | `false`          | She may work inside other programs (each one is asked about first)                                                                   |
| `sight.watch`              | `false`          | She keeps an eye on the screen all the time                                                                                          |
| `sight.watchSkip`          | `[]`             | Programs she never reads while watching, such as `["signal"]`                                                                        |
| `hearing.pcAudio`          | `false`          | She keeps the last minute and a half of what the PC played                                                                           |
| `notices.read`             | `false`          | She may read desktop notifications; what she reads is kept in memory only                                                            |
| `notices.skip`             | `[]`             | Programs whose notifications she never reads, on top of the built-in list, such as `["signal"]`                                      |
| `agenda.calendars`         | `[]`             | Calendars she reads: each a name and a file path or an `https://` feed address. Add them in Settings                                 |
| `agenda.headsUpMinutes`    | `15`             | Minutes of warning before something on the agenda starts. `0` turns it off                                                           |
| `devices.station`          | `false`          | Other devices on the home network may talk to her                                                                                    |
| `devices.stationPort`      | `47821`          | The port that page is served on                                                                                                      |
| `devices.pingPhone`        | `false`          | Reminders are also sent to a phone paired through KDE Connect                                                                        |
| `fleet.machines`           | `[]`             | Your other machines, each with a name, address, port, account and whether she may check its status unasked. Add them in Settings     |
| `handsOff`                 | `false`          | She may only talk and look things up                                                                                                 |
| `keepConversations`        | `true`           | Keep past conversations on this computer so she can look back                                                                        |
| `search.searxngUrl`        | `null`           | Address of a SearXNG you run yourself, if any                                                                                        |
| `search.braveApiKey`       | `null`           | A Brave Search key of your own, if any                                                                                               |
| `search.braveMonthlyLimit` | `1000`           | The most searches she sends to Brave in a calendar month. `0` means no limit                                                         |
| `doNotDisturb`             | `false`          | Hold back everything you did not ask to be told                                                                                      |
| `morningBriefing`          | `true`           | A short briefing the first time she starts each day                                                                                  |

## Limits you should know about

- **Clicks do not pass through the window.** On Wayland an app cannot make part of its window click-through, so the window shrinks to a box around her when nothing is open. Things directly behind that box cannot be clicked until you move or hide her.
- **Her position resets when the app restarts.** She returns to the bottom-right corner.
- **Her name is not always heard right.** Her name is caught by ordinary speech recognition, which was not trained on it, so now and then "AI-chan" comes out as something else and she does not react. In tests with synthetic voices, her name with a request after it was caught in 24 of 28 tries and her name alone in 9 of 15; real voices have not been tested. Saying it with a request ("AI-chan, open Firefox") is the most reliable. If she keeps missing it in your voice, add a name she will also answer to with `voice.otherNames` in the settings, for example `["Computer"]`.
- **Her write-ups are only as good as her brain.** Notes are written by the same local model. The standard model writes sensible key points, but it can file a passing remark as a project or word a step loosely. Look over **What she has learned…** now and then and have her forget what is wrong.
- **Use headphones if she interrupts herself.** Echo cancellation keeps her from hearing her own voice in most setups, but loud speakers close to the microphone can still set her off.
- **Reading office documents needs LibreOffice**, which she runs with no network access (through `bwrap`, when it is installed) so that a document cannot make it fetch anything.
- **Her lookups are narrower than a search engine.** Without a search engine of your own she draws on open sources: strong for encyclopedic, programming and Linux questions, thin for shopping, local or very recent things. Her research says so in its "Not sure about" section instead of guessing. For wider answers, give her a SearXNG you run or a Brave Search key in Settings. With a Brave key she counts her own searches and stops at the monthly number you set (1,000 unless you change it), going back to the open sources until the month ends; her self-check says how many are used. When the open sources find too little in conversation she falls back to DuckDuckGo in her own browser, which may put a "prove you are human" window in front of you; she does not try to get around it.
- **Her eyes read better than they see.** The text on screen is read well. The description of what is shown comes from a small model: it gets the gist ("a person standing in a field of tall grass") and misses detail. Keeping watch means knowing which window is in front and reading the small ones that pop up, not seeing every frame.
- **Working inside programs depends on the program.** Programs built with Qt and GTK describe their controls well. Browsers and Electron apps describe little unless started with accessibility on, and games describe nothing; there she falls back to clicking on words she can see, which is slower and can miss. She works one step at a time and the standard brain sometimes needs telling to check its result. Filling in is only for one-line fields: she will not replace the contents of a document. Shortcut letters assume a QWERTY keyboard. Working inside programs needs KDE Plasma on Wayland, `python3` with `python-gobject`, and permission to use `/dev/uinput` for the pointer and keyboard (many desktops grant this to the person logged in; without it she can still press named controls).
- **A firewall on the PC blocks the station until you let it through.** With `ufw` or `firewalld` running, another device only says "site can't be reached". Settings shows the one command that allows her port for your home network. The address needs its `https://`; a browser that leaves it off is sent to the right place by the station itself.
- **The station is for your home network.** It is not meant to be reached from the internet, and it refuses addresses outside private ranges. Anyone who holds a paired device and can sign in on it can talk to her and hear her answers, including what she remembers and what her lookups and your ordinary files tell her, so pair only your own devices, keep the password to yourself, and remove a device you lose. The other device needs a browser; there is no app, and no voice there yet.
- **Her other machines need SSH.** A machine has to accept SSH sign-in with a key for the account you give her. Commands that stop to ask a question (a password for `sudo`, a yes or no) do not work: sign her in as an account that may do the job, or allow that account `sudo` without a password. She does one command at a time and waits for it, up to ten minutes; if she gives up on one, only her connection is closed and the command may carry on there. There are no long-running remote jobs yet. The machine needs the everyday `base64`, `head`, `cat` and `mv` programs, which servers and NAS systems have. Letting her key in with the password window needs `kdialog` or `zenity`; without them, copy her key by hand. Seen working on one real machine (a Linux VM signed in to by key): status checks, a file written and read back, a standing order, and forgetting the machine. Sending and fetching files have only been tested against a private SSH server on the development PC. Letting her key in with a password has never been tried against a real password sign-in: only the small script that adds her key on the machine is tested. If it fails for you, add the key by hand (**Copy her key** in Settings, then append it to `~/.ssh/authorized_keys` there).
- **Window titles pass through the system log when she works with windows.** Listing windows, bringing one forward and working inside a program ask the window manager through a small script whose answer is read back from your user's own log, titles included. Merely keeping watch does not: those reports go straight to her.
- **She hears the PC, not the room.** Her memory of what the PC played is a recording of its output only, turned into words by the same recogniser that hears you. Song lyrics, crowd noise and several people at once come out poorly.
- **Some desktop controls need KDE.** Windows and the clipboard go through KWin and Klipper. Sound uses PipeWire and the standard media-player interface and works on other desktops.
- **Offering her fewer tools saves room, not mistakes.** With **Offer her only the tools a message needs** on, she holds about 5,500 tokens after a first message instead of 8,800, which leaves more of her working memory for the conversation. Measured on her test suite with both brains, it made her neither better nor worse at choosing a tool (small brain 86% with it, 84% without; standard 88% and 87%: the same within noise). The tools are picked by the words of your message, by nearness in meaning, and by what was used in the last few replies; a request put in a roundabout way can miss the tool it needs, in which case she says she cannot, is given every tool, and tries once more. It is off unless you switch it on.
- **The first message after she wakes is the slow one.** Before she can answer she reads her instructions and tools, about 8,500 tokens with everything switched on: two to three seconds on a graphics card, over a minute with no graphics card at all. After that she keeps her place, so later messages, a fresh conversation and a tidied-up long one cost a fraction of a second of reading.
- **She is not free while visible.** Measured on the development machine: about 15% of one processor core while awake and idle, 12% asleep, 0.4% with her window hidden, and no measurable load on the graphics card when idle. Asleep she keeps about 300 MB of graphics memory; awake with the standard brain, about 7 GB.
- **Both smaller brains need the follow-through check, and it is rules, not judgement.** The 4B and 9B models sometimes say a thing is done, or that they looked something up, without calling the tool; or they announce "let me check" and stop. The app compares what she said with what her tools actually did in that reply. When they disagree she is sent back once to do it, and if she still has not, a plain note under her reply says so. The same goes for a question only a tool can answer (the volume, the weather, your agenda, how long you have been in a game) answered without one, and for a sum worth a calculator done in her head. Any sum she writes out in full is worked out again by the calculator, and a wrong figure gets the right one shown beneath it. This costs a second or two when it happens. The rules are lists of wordings, in English with a smaller set for Japanese and Chinese: a claim worded in a way no rule knows passes unnoticed, and reasoning mistakes in a word problem are not caught at all.
- **The same call is not made three times running.** A small model that has its answer sometimes asks for it again, word for word, until its steps run out. The third identical call in a row is not made and she is told to answer from what she has.
- **Video editing is `ffmpeg` only** unless you install an editor such as Kdenlive. She can do cuts, joins, crops, resizing and conversions herself; timeline work needs an editor.
- **Expressions depend on the model.** Faces use the standard MMD morph names. The names a model actually has are printed when it loads (run with `AI_CHAN_DEBUG=1 npm start`), and the mapping lives at the top of `src/renderer/src/stage.ts`.
- **The model packing is a strong deterrent, not DRM.** See [NOTICE.md](NOTICE.md).

## Working on it

```sh
npm run check                  # type-check, lint and tests
npm run build                  # Electron main + preload + renderer build
npm run chat                   # talk to the assistant in a terminal, without the window
npm run eval                   # her test suite against a pretend world (see evals/README.md)
npm run eval -- --fuzz         # 500-case deterministic security/taint fuzz gate (no GPU needed)
npm run eval -- --audit        # static policy & standing-order rule conflict audit
npm run prompt-size            # how many tokens her instructions and each tool cost
scripts/test-desktop.sh <command>   # run something in a private, invisible desktop
```

See [SECURITY.md](SECURITY.md) for the security boundary architecture and [CONTRIBUTING.md](CONTRIBUTING.md) for Windows & macOS `PlatformAdapter` contribution guidelines.

**Why did she do that?** For every reply the app keeps a record: what was said to her, which tools she was offered (and, when tools are picked per message, why each one), every tool call with what she asked of it, what it answered and how it ended, what she said, and where the app's own checks sent her back or put a note under her reply, with timings and token counts. The last forty are held in memory and shown in Settings under **Her mind › Why did she do that?**; they are gone when she is closed. Switch on **Keep a record of each reply on this computer** and each is also written as one line to `traces.jsonl` in her data folder, readable only by you. That file holds what you asked and what she answered, so treat it like your conversations; "Forget conversations" erases it. The text of notifications is never in a record, nor is her private thinking.

`npm run export-pairs -- --traces ~/.local/share/ai-chan/traces.jsonl --out lessons.jsonl` (or with the names of test-suite reports in place of `--traces`) turns records into two kinds of example for teaching the small brain: "corrected" (a reply the checks sent back, beside the second go that did it properly) and "clean" (a reply that used its tools to the end and needed nothing put right). Both are made only of the local model's own output and its tools' answers; nothing is added or reworded.

`npm run eval` loads a model onto the graphics card and refuses to start while a game has the card. `npm run eval -- --cpu 4 --cases tools/timer,honesty/` runs chosen cases with the small brain on the processor alone, slowly, and leaves the card to the game.

`scripts/test-desktop.sh` starts a second window manager that draws to nowhere, with its own session and home folder, and runs your command in it. Programs started there open their windows there, so her eyes and hands can be tried on real programs (`kcalc`, `kwrite`, the app itself with `--ozone-platform=wayland`) without anything appearing on your screen. The virtual pointer and keyboard are switched off inside it, because those are real devices and would act on your real desktop.

| Folder                   | What is in it                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `src/core/`              | The assistant itself: personality, memory, permission rules, tools, `ruleAudit.ts`, `replay.ts`, local engine. |
| `src/core/platform/`     | `PlatformAdapter` contract & OS backends (`linux.ts`, `windows.ts`, `winSandbox.ts`, `safety.ts`).             |
| `src/core/voice/`        | Listening (voice detection and recognition) and speaking.                                                      |
| `assets/models/ai-navigator/` | Bundled original Astra Navi 3D MMD character (`CC-BY-4.0 / MIT`), built via `scripts/blender/build_navigator_mmd.py`. |
| `voice-server/`          | The Python program behind the designed voices, and the script that designs a voice.                            |
| `hands/`                 | The small Python helper that reads and presses other programs' controls and owns the virtual pointer.          |
| `phone-app/`             | The Android app for the station: one screen of Java and its build inputs. Built by `scripts/build-android.sh`. |
| `assets/voice/`          | The designed voices: one short synthetic reference clip each.                                                  |
| `src/main/`              | The desktop app: window, tray, the private protocol that serves the model, the KDE helper.                     |
| `src/renderer/`          | What you see and hear: the 3D stage, the speech balloon, the message box, microphone and playback.             |
| `tests/`                 | Unit tests for `src/core/`, character bundle/PMX inspection (`tests/customModel.test.ts`), and policy gates.   |
| `evals/`                 | Her test suite & deterministic security fuzzer (`evals/fuzz.ts`, `evals/cases/`, `evals/world.ts`).            |
| `train/`                 | A trainer for tuning the small brain's weights and self-distillation exports.                                  |

Downloaded models live in `~/.local/share/ai-chan/models/`. They are safe to delete; they download again when needed.
