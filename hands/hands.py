#!/usr/bin/env python3
"""AI-chan's hands in other programs.

A small helper the app starts when she needs to work a program the way a person does.
It does three things, each asked for by one line of JSON on standard input and answered
by one line on standard output:

- reads a window's controls (buttons, menus, fields) through the desktop's
  accessibility service, and presses them or fills them in;
- moves a virtual pointer and presses virtual keys, for programs that do not describe
  their controls;
- listens for the window manager telling it which window is in front, so the app can
  follow that without anything being written to the system log.

It decides nothing. Every rule about what she may touch lives in the app; this only
carries out single steps. It uses nothing outside the Python standard library except
the desktop's own accessibility bindings (python-gobject), and works without those,
with the pointer and keyboard only.
"""

# The accessibility bindings (gi) ship no type information, so nearly every value that
# comes back from them is "Any", and the kernel calls below return values there is
# nothing to do with. Those reports would bury the ones worth reading, so they are off
# for this file only; everything else the type checker says still applies.
# pyright: reportAny=false, reportExplicitAny=false, reportUnusedCallResult=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

import contextlib
import fcntl
import importlib
import json
import os
import struct
import sys
import time
import warnings
from typing import Any

# The bindings mark some calls as old; they are the ones every toolkit still answers.
warnings.filterwarnings("ignore", category=DeprecationWarning)

# The desktop's accessibility bindings come without type information and may be missing
# altogether, so they are loaded by name and held as plain objects. A type checker can
# therefore say little about the calls made on them below; what they do is covered by
# the runs in scripts/test-desktop.sh instead.
Atspi: Any = None
Gio: Any = None
GLib: Any = None
gi_problem = ""
try:
    gi = importlib.import_module("gi")
    gi.require_version("Atspi", "2.0")
    Atspi = importlib.import_module("gi.repository.Atspi")
    Gio = importlib.import_module("gi.repository.Gio")
    GLib = importlib.import_module("gi.repository.GLib")
except Exception as error:  # noqa: BLE001 - any failure here just means "no accessibility"
    gi_problem = str(error)
HAVE_GI: bool = GLib is not None
GI_PROBLEM: str = gi_problem


def say(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Refused(Exception):
    """Something she asked for cannot be done; the message is for her to read."""


# When the app stops waiting for the request being handled (seconds since 1970), or 0.
deadline = 0.0


def still_wanted() -> None:
    """Called just before anything is pressed, typed or clicked. A step the app has
    already given up on (and told her had failed) must not happen late."""
    if deadline and time.time() > deadline:
        raise Refused("LATE")


# ---------------------------------------------------------------- virtual input

EV_SYN, EV_KEY, EV_REL, EV_ABS, EV_MSC = 0, 1, 2, 3, 4
MSC_SCAN = 4
SYN_REPORT = 0
REL_WHEEL = 8
ABS_X, ABS_Y = 0, 1
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
ABS_MAX = 32767
BUS_VIRTUAL = 0x06

UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_DEV_SETUP = 0x405C5503
UI_ABS_SETUP = 0x401C5504
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_SET_MSCBIT = 0x40045568

# Keys by the names she uses. These are positions on the keyboard, so letters assume the
# usual QWERTY arrangement; the named keys (enter, tab, arrows) are the same everywhere.
KEYS: dict[str, int] = {
    "esc": 1, "escape": 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9,
    "9": 10, "0": 11, "minus": 12, "-": 12, "equal": 13, "=": 13, "backspace": 14, "tab": 15,
    "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23, "o": 24, "p": 25,
    "[": 26, "]": 27, "enter": 28, "return": 28, "ctrl": 29, "control": 29, "a": 30, "s": 31,
    "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37, "l": 38, ";": 39, "'": 40, "`": 41,
    "shift": 42, "\\": 43, "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
    ",": 51, ".": 52, "/": 53, "alt": 56, "space": 57, "f1": 59, "f2": 60, "f3": 61,
    "f4": 62, "f5": 63, "f6": 64, "f7": 65, "f8": 66, "f9": 67, "f10": 68, "f11": 87,
    "f12": 88, "home": 102, "up": 103, "pageup": 104, "left": 105, "right": 106, "end": 107,
    "down": 108, "pagedown": 109, "insert": 110, "delete": 111, "del": 111, "super": 125,
    "meta": 125, "win": 125, "menu": 127,
}  # fmt: skip
MODIFIERS = {"ctrl", "control", "shift", "alt", "super", "meta", "win"}


class VirtualInput:
    """A pointer and a keyboard that exist only while she is working."""

    def __init__(self) -> None:
        self.pointer: int | None = None
        self.keyboard: int | None = None

    @staticmethod
    def _open() -> int:
        # For trying her out on a desktop someone is using: nothing is ever sent.
        if os.environ.get("AI_CHAN_NO_VIRTUAL_INPUT"):
            raise Refused(
                "The virtual pointer and keyboard are switched off for this run."
            )
        try:
            return os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        except OSError as error:
            raise Refused(
                "This computer does not let her make a virtual pointer or keyboard "
                + f"(/dev/uinput: {error.strerror})."
            ) from error

    @staticmethod
    def _create(fd: int, name: str) -> None:
        setup = struct.pack(
            "HHHH80sI", BUS_VIRTUAL, 0x1209, 0xA1C4, 1, name.encode(), 0
        )
        fcntl.ioctl(fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(fd, UI_DEV_CREATE)

    def _pointer(self) -> int:
        if self.pointer is None:
            fd = self._open()
            # Exactly these kinds of event, and exactly three buttons and two axes: that is
            # the shape the kernel knows as an "absolute mouse". With any other shape it
            # would also be offered to games as a joystick.
            for kind in (EV_KEY, EV_ABS, EV_REL, EV_MSC):
                fcntl.ioctl(fd, UI_SET_EVBIT, kind)
            fcntl.ioctl(fd, UI_SET_MSCBIT, MSC_SCAN)
            for button in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
                fcntl.ioctl(fd, UI_SET_KEYBIT, button)
            fcntl.ioctl(fd, UI_SET_RELBIT, REL_WHEEL)
            for axis in (ABS_X, ABS_Y):
                fcntl.ioctl(fd, UI_SET_ABSBIT, axis)
                # code, padding, then value, minimum, maximum, fuzz, flat, resolution
                fcntl.ioctl(
                    fd,
                    UI_ABS_SETUP,
                    struct.pack("HHiiiiii", axis, 0, 0, 0, ABS_MAX, 0, 0, 0),
                )
            self._create(fd, "AI-chan virtual pointer")
            self.pointer = fd
            time.sleep(0.7)  # the desktop needs a moment to notice a new device
        return self.pointer

    def _keyboard(self) -> int:
        if self.keyboard is None:
            fd = self._open()
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            for code in set(KEYS.values()):
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            self._create(fd, "AI-chan virtual keyboard")
            self.keyboard = fd
            time.sleep(0.7)
        return self.keyboard

    def arm(self) -> None:
        """Makes both devices now, so the first real step does not wait for them."""
        self._pointer()
        self._keyboard()

    @staticmethod
    def _send(fd: int, *events: tuple[int, int, int]) -> None:
        for kind, code, value in events:
            os.write(fd, struct.pack("llHHi", 0, 0, kind, code, value))
        os.write(fd, struct.pack("llHHi", 0, 0, EV_SYN, SYN_REPORT, 0))

    def move(self, x: float, y: float) -> None:
        fd = self._pointer()
        px = min(ABS_MAX, max(0, round(x * ABS_MAX)))
        py = min(ABS_MAX, max(0, round(y * ABS_MAX)))
        # Two reports: a device's very first position is sometimes taken as "no movement".
        self._send(fd, (EV_ABS, ABS_X, max(0, px - 1)), (EV_ABS, ABS_Y, py))
        time.sleep(0.02)
        self._send(fd, (EV_ABS, ABS_X, px), (EV_ABS, ABS_Y, py))
        time.sleep(0.05)

    def click(self, button: str, clicks: int) -> None:
        fd = self._pointer()
        code = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}.get(button)
        if code is None:
            raise Refused(f'There is no "{button}" button.')
        for _ in range(max(1, min(3, clicks))):
            self._send(fd, (EV_KEY, code, 1))
            time.sleep(0.04)
            self._send(fd, (EV_KEY, code, 0))
            time.sleep(0.09)

    def scroll(self, notches: int) -> None:
        fd = self._pointer()
        step = -1 if notches > 0 else 1  # the wheel counts upward turns as positive
        for _ in range(min(40, abs(notches))):
            self._send(fd, (EV_REL, REL_WHEEL, step))
            time.sleep(0.02)

    def keys(self, combo: list[str], times: int) -> None:
        names = [name.strip().lower() for name in combo if name.strip()]
        unknown = [name for name in names if name not in KEYS]
        if unknown or not names:
            raise Refused(
                f'She has no key called "{unknown[0] if unknown else ""}". Keys are written '
                + 'like "ctrl+s", "enter", "alt+f4", "down".'
            )
        held = [KEYS[name] for name in names if name in MODIFIERS]
        tapped = [KEYS[name] for name in names if name not in MODIFIERS]
        fd = self._keyboard()
        try:
            for code in held:
                self._send(fd, (EV_KEY, code, 1))
                time.sleep(0.02)
            for _ in range(max(1, min(30, times))):
                # A combination of only modifiers ("super") is itself the key being tapped.
                for code in tapped or held[-1:]:
                    if tapped:
                        self._send(fd, (EV_KEY, code, 1))
                        time.sleep(0.03)
                        self._send(fd, (EV_KEY, code, 0))
                        time.sleep(0.03)
        finally:
            # Whatever happens, no key is left held down.
            for code in reversed(held):
                self._send(fd, (EV_KEY, code, 0))
                time.sleep(0.02)

    def close(self) -> None:
        for fd in (self.pointer, self.keyboard):
            if fd is not None:
                try:
                    fcntl.ioctl(fd, UI_DEV_DESTROY)
                    os.close(fd)
                except OSError:
                    pass
        self.pointer = None
        self.keyboard = None


# ---------------------------------------------------------------- accessibility

MAX_NODES = 4000
MAX_DEPTH = 40
MAX_LISTED = 70
MAX_VALUE_CHARS = 160
MAX_TEXT_CHARS = 1800

if HAVE_GI:
    R = Atspi.Role
    # What counts as a control she can use, and what she calls it.
    CONTROL_ROLES = {
        R.PUSH_BUTTON: "button", R.TOGGLE_BUTTON: "toggle", R.CHECK_BOX: "checkbox",
        R.RADIO_BUTTON: "radio", R.MENU: "menu", R.MENU_ITEM: "menu item",
        R.CHECK_MENU_ITEM: "menu item", R.RADIO_MENU_ITEM: "menu item", R.COMBO_BOX: "choice",
        R.TEXT: "field", R.ENTRY: "field", R.PASSWORD_TEXT: "password field",
        R.SPIN_BUTTON: "number field", R.SLIDER: "slider", R.LINK: "link", R.PAGE_TAB: "tab",
        R.LIST_ITEM: "list item", R.TREE_ITEM: "list item", R.TABLE_CELL: "cell",
        R.ICON: "icon", R.PUSH_BUTTON_MENU: "button", R.SWITCH: "switch",
    }  # fmt: skip
    FIELD_ROLES = {R.TEXT, R.ENTRY, R.SPIN_BUTTON, R.PARAGRAPH, R.DOCUMENT_TEXT}
    TEXT_ROLES = {
        R.LABEL, R.STATIC, R.PARAGRAPH, R.HEADING, R.STATUS_BAR, R.ALERT, R.NOTIFICATION,
        R.DOCUMENT_TEXT, R.TEXT,
    }  # fmt: skip
    WINDOW_ROLES = {R.FRAME, R.DIALOG, R.WINDOW, R.ALERT, R.FILE_CHOOSER}
    # Tried in this order; the first one a control offers is what "press" does to it.
    PRESSING = (
        "press",
        "click",
        "activate",
        "toggle",
        "select",
        "jump",
        "open",
        "trigger",
    )


def fold(text: str) -> str:
    """Lower case, with the '&' and '…' that toolkits put in button names taken out."""
    return " ".join(
        text.replace("&", "").replace("…", "").replace("...", "").casefold().split()
    )


class Controls:
    """Reads and works a window's controls through the accessibility service."""

    def __init__(self) -> None:
        self.ready: bool = False
        self.enabled_by_us: bool = False
        # The controls last listed, by the number she was shown, so "the third one" works.
        self.listed: dict[int, Any] = {}
        # The program that list came from. A number means nothing in any other.
        self.listed_pid: int = -1
        self.inited: bool = False

    def prepare(self) -> None:
        if not HAVE_GI:
            raise Refused(
                "The desktop's accessibility bindings (python-gobject, at-spi2-core) are not "
                + f"installed, so she cannot read programs' controls ({GI_PROBLEM})."
            )
        if self.ready:
            return
        self._switch_on()
        if not self.inited:
            Atspi.init()
            # A program that has hung must not hang her with it.
            Atspi.set_timeout(1500, 4000)
            self.inited = True
        self.ready = True

    def _status(self) -> Any:
        return Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            None,
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.freedesktop.DBus.Properties",
            None,
        )

    def _switch_on(self) -> None:
        """Programs only describe their controls while the desktop says someone is reading."""
        if os.environ.get("AT_SPI_BUS_ADDRESS"):
            return
        # Without the switch, toolkits that are always on still work, so a failure here is let pass.
        with contextlib.suppress(Exception):
            status = self._status()
            reply = status.call_sync(
                "Get",
                GLib.Variant("(ss)", ("org.a11y.Status", "IsEnabled")),
                Gio.DBusCallFlags.NONE,
                2000,
                None,
            )
            if reply.unpack()[0]:
                return
            status.call_sync(
                "Set",
                GLib.Variant(
                    "(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))
                ),
                Gio.DBusCallFlags.NONE,
                2000,
                None,
            )
            self.enabled_by_us = True
            time.sleep(
                1.2
            )  # running programs wake their descriptions up on this signal

    def switch_off(self) -> None:
        if not self.enabled_by_us:
            return
        with contextlib.suppress(Exception):
            self._status().call_sync(
                "Set",
                GLib.Variant(
                    "(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", False))
                ),
                Gio.DBusCallFlags.NONE,
                2000,
                None,
            )
        self.enabled_by_us = False
        # Next time she needs controls the switch is looked at again, and put back on.
        self.ready = False

    # ----- finding things

    def _window(self, pid: int, title: str) -> Any | None:
        """The accessible window of the program with this process id, best match by title."""
        # Without a real process id there is no telling whose window this is: an id of -1
        # is also what a program that does not answer reports.
        if pid <= 0:
            return None
        desktop = Atspi.get_desktop(0)
        wanted = fold(title)
        best: tuple[int, Any] | None = None
        for _attempt in range(4):
            for index in range(desktop.get_child_count()):
                try:
                    app = desktop.get_child_at_index(index)
                    if app is None or app.get_process_id() != pid:
                        continue
                    for child_index in range(app.get_child_count()):
                        window = app.get_child_at_index(child_index)
                        if window is None:
                            continue
                        name = fold(window.get_name() or "")
                        states = window.get_state_set()
                        score = 1
                        if states.contains(Atspi.StateType.SHOWING):
                            score += 2
                        if states.contains(Atspi.StateType.ACTIVE):
                            score += 3
                        if name and name == wanted:
                            score += 10
                        elif name and (name in wanted or wanted in name):
                            score += 5
                        if best is None or score > best[0]:
                            best = (score, window)
                except GLib.Error:
                    continue
            if best is not None:
                break
            time.sleep(
                0.4
            )  # a program that was just told to describe itself may need a moment
        return None if best is None else best[1]

    @staticmethod
    def _states(node: Any) -> Any:
        return node.get_state_set()

    @staticmethod
    def _label(node: Any) -> str:
        """A control's name; a field often has none of its own and is named by its label."""
        name = (node.get_name() or "").strip()
        if name:
            return name
        try:
            for relation in node.get_relation_set() or []:
                if relation.get_relation_type() == Atspi.RelationType.LABELLED_BY:
                    target = relation.get_target(0)
                    if target is not None and target.get_name():
                        return target.get_name().strip()
        except GLib.Error:
            pass
        return (node.get_description() or "").strip()

    @staticmethod
    def _value(node: Any, role: Any) -> str | None:
        if role == Atspi.Role.PASSWORD_TEXT:
            return None  # never read, whatever the program would hand over
        try:
            if node.get_text_iface() is not None and role in FIELD_ROLES | {
                Atspi.Role.COMBO_BOX
            }:
                count = Atspi.Text.get_character_count(node)
                text = Atspi.Text.get_text(node, 0, min(count, MAX_VALUE_CHARS))
                return text + ("…" if count > MAX_VALUE_CHARS else "")
            if node.get_value_iface() is not None and role in (
                Atspi.Role.SLIDER,
                Atspi.Role.SPIN_BUTTON,
            ):
                return f"{Atspi.Value.get_current_value(node):g}"
        except GLib.Error:
            pass
        return None

    def _walk(self, root: Any) -> list[tuple[Any, Any, int]]:
        """Every node under a window as (node, role, depth), within a fixed budget."""
        found: list[tuple[Any, Any, int]] = []
        stack: list[tuple[Any, int]] = [(root, 0)]
        while stack and len(found) < MAX_NODES:
            node, depth = stack.pop()
            try:
                role = node.get_role()
                found.append((node, role, depth))
                if depth >= MAX_DEPTH:
                    continue
                count = min(node.get_child_count(), 400)
                for index in range(count - 1, -1, -1):
                    child = node.get_child_at_index(index)
                    if child is not None:
                        stack.append((child, depth + 1))
            except GLib.Error:
                continue
        return found

    def _describe(self, number: int, node: Any, role: Any) -> dict[str, Any]:
        states = self._states(node)
        entry: dict[str, Any] = {
            "n": number,
            "kind": CONTROL_ROLES.get(role, node.get_role_name()),
            "name": self._label(node)[:120],
        }
        value = self._value(node, role)
        if value:
            entry["value"] = value
        if states.contains(Atspi.StateType.CHECKED):
            entry["on"] = True
        elif role in (
            Atspi.Role.CHECK_BOX,
            Atspi.Role.TOGGLE_BUTTON,
            Atspi.Role.SWITCH,
            Atspi.Role.RADIO_BUTTON,
        ):
            entry["on"] = False
        if states.contains(Atspi.StateType.SELECTED):
            entry["selected"] = True
        if not states.contains(Atspi.StateType.ENABLED):
            entry["greyed"] = True
        if states.contains(Atspi.StateType.FOCUSED):
            entry["focused"] = True
        if not states.contains(Atspi.StateType.SHOWING):
            entry["hidden"] = True
        with contextlib.suppress(GLib.Error):
            if node.get_component_iface() is not None:
                ext = Atspi.Component.get_extents(node, Atspi.CoordType.SCREEN)
                if ext.width > 0 and ext.height > 0:
                    entry["rect"] = {
                        "x": int(ext.x),
                        "y": int(ext.y),
                        "width": int(ext.width),
                        "height": int(ext.height),
                    }
        return entry

    def _open_window(self, pid: int, title: str) -> Any:
        self.prepare()
        window = self._window(pid, title)
        if window is None:
            raise Refused("BARE")
        try:
            window.clear_cache_single()
        except (AttributeError, GLib.Error):
            pass
        return window

    def list(self, pid: int, title: str, words: str) -> dict[str, Any]:
        window = self._open_window(pid, title)
        nodes = self._walk(window)
        wanted = fold(words).split()
        self.listed = {}
        self.listed_pid = pid
        controls: list[dict[str, Any]] = []
        texts: list[str] = []
        text_chars = 0
        total = 0
        for node, role, _depth in nodes:
            try:
                states = self._states(node)
                showing = states.contains(Atspi.StateType.SHOWING)
                if role in CONTROL_ROLES:
                    name = self._label(node)
                    # A nameless control cannot be asked for by name; fields are the exception.
                    if (
                        not name
                        and role not in FIELD_ROLES
                        and role != Atspi.Role.PASSWORD_TEXT
                    ):
                        continue
                    if wanted:
                        if not all(word in fold(name) for word in wanted):
                            continue
                    elif not showing:
                        continue
                    total += 1
                    if len(controls) < MAX_LISTED:
                        number = len(controls) + 1
                        self.listed[number] = node
                        controls.append(self._describe(number, node, role))
                elif (
                    role in TEXT_ROLES
                    and showing
                    and not wanted
                    and text_chars < MAX_TEXT_CHARS
                ):
                    text = (node.get_name() or "").strip()
                    if not text and node.get_text_iface() is not None:
                        count = Atspi.Text.get_character_count(node)
                        text = Atspi.Text.get_text(node, 0, min(count, 400)).strip()
                    if text and text not in texts:
                        texts.append(text[:400])
                        text_chars += len(text[:400])
            except GLib.Error:
                continue
        return {
            "window": (window.get_name() or "")[:160],
            "controls": controls,
            "more": max(0, total - len(controls)),
            "text": texts,
            "nodes": len(nodes),
        }

    def _find(
        self, pid: int, title: str, name: str, number: int | None, fields: bool
    ) -> Any:
        if number is not None:
            # A number only stands for something in the list made for this same program.
            node = self.listed.get(number) if self.listed_pid == pid else None
            try:
                listed_name = fold(self._label(node)) if node is not None else None
                same_program = node is not None and node.get_process_id() == pid
            except GLib.Error as error:
                raise Refused(
                    "That window has changed. List its controls again."
                ) from error
            # A number given together with a name is only a hint: the name decides, so a
            # list that has since changed cannot make her press something else.
            if name and listed_name != fold(name):
                number = None
            elif node is None or not same_program:
                raise Refused(
                    f"There is no number {number} in the last list for that window. "
                    + "List its controls again."
                )
            else:
                return node
        window = self._open_window(pid, title)
        wanted = fold(name)
        # Each candidate as (exact, usable now, closeness, node, role); the best sorts first.
        ranked: list[tuple[bool, bool, int, Any, Any]] = []
        for node, role, _depth in self._walk(window):
            try:
                if fields:
                    editable = self._states(node).contains(Atspi.StateType.EDITABLE)
                    if not editable and role not in (
                        Atspi.Role.ENTRY,
                        Atspi.Role.PASSWORD_TEXT,
                        Atspi.Role.SPIN_BUTTON,
                    ):
                        continue
                elif role not in CONTROL_ROLES:
                    continue
                label = fold(self._label(node))
                states = self._states(node)
                usable = states.contains(Atspi.StateType.SHOWING) and states.contains(
                    Atspi.StateType.ENABLED
                )
                exact = False
                if fields and not wanted:
                    # No name given: the field being typed in, or the only one there is.
                    closeness = 30 if states.contains(Atspi.StateType.FOCUSED) else 10
                elif not label or not wanted:
                    continue
                elif label == wanted:
                    exact, closeness = True, 100
                elif len(wanted) < 3:
                    continue  # "7" or "+" must be the whole name, or it matches half the window
                elif label.startswith(wanted):
                    closeness = 60
                elif all(word in label.split() for word in wanted.split()):
                    closeness = 45
                elif wanted in label:
                    closeness = 30
                else:
                    continue
                ranked.append((exact, usable, closeness, node, role))
            except GLib.Error:
                continue
        if not ranked:
            raise Refused("NOMATCH")
        ranked.sort(key=lambda entry: (not entry[0], not entry[1], -entry[2]))
        exact_matches = [entry for entry in ranked if entry[0]]
        if not fields:
            # A control is only pressed on its whole name. What she was allowed to do was
            # decided from the name she gave; a name that merely resembles a control's
            # ("mess" for "Send message") must not be turned into a press of it. The
            # near misses are handed back so she can ask again by the real name.
            if not exact_matches:
                near = [entry for entry in ranked if entry[1]][:8]
                if not near:
                    raise Refused("NOMATCH")
                self._remember(pid, near)
                raise Refused(
                    "CLOSEST " + json.dumps(self._choices(near), ensure_ascii=False)
                )
            top = [entry for entry in exact_matches if entry[1] == exact_matches[0][1]]
        else:
            top = [entry for entry in ranked if entry[:3] == ranked[0][:3]]
        if len(top) > 1:
            self._remember(pid, top[:12])
            raise Refused(
                "SEVERAL " + json.dumps(self._choices(top[:12]), ensure_ascii=False)
            )
        return top[0][3]

    def _remember(
        self, pid: int, entries: list[tuple[bool, bool, int, Any, Any]]
    ) -> None:
        self.listed = {index: entry[3] for index, entry in enumerate(entries, start=1)}
        self.listed_pid = pid

    def _choices(
        self, entries: list[tuple[bool, bool, int, Any, Any]]
    ) -> list[dict[str, Any]]:
        return [
            self._describe(index, entry[3], entry[4])
            for index, entry in enumerate(entries, start=1)
        ]

    def press(
        self, pid: int, title: str, name: str, number: int | None, rehearse: bool
    ) -> dict[str, Any]:
        node = self._find(pid, title, name, number, fields=False)
        role = node.get_role()
        what = {
            "kind": CONTROL_ROLES.get(role, node.get_role_name()),
            "name": self._label(node)[:120],
        }
        if not self._states(node).contains(Atspi.StateType.ENABLED):
            raise Refused(
                f'The {what["kind"]} "{what["name"]}" is greyed out right now.'
            )
        if rehearse:
            return {"pressed": what, "rehearsed": True}
        done = False
        if node.get_action_iface() is not None:
            names = [
                (Atspi.Action.get_action_name(node, index) or "").casefold()
                for index in range(Atspi.Action.get_n_actions(node))
            ]
            for wanted in PRESSING:
                if wanted in names:
                    still_wanted()
                    done = Atspi.Action.do_action(node, names.index(wanted))
                    break
            else:
                usable = [
                    index
                    for index, action in enumerate(names)
                    if action not in ("setfocus", "showmenu")
                ]
                if usable:
                    still_wanted()
                    done = Atspi.Action.do_action(node, usable[0])
        if not done:
            parent = node.get_parent()
            if parent is not None and parent.get_selection_iface() is not None:
                done = Atspi.Selection.select_child(parent, node.get_index_in_parent())
        if not done:
            raise Refused(
                f'The {what["kind"]} "{what["name"]}" cannot be pressed this way.'
            )
        time.sleep(0.25)
        after: dict[str, Any] = {"pressed": what}
        try:
            states = self._states(node)
            if role in (
                Atspi.Role.CHECK_BOX,
                Atspi.Role.TOGGLE_BUTTON,
                Atspi.Role.SWITCH,
                Atspi.Role.RADIO_BUTTON,
                Atspi.Role.CHECK_MENU_ITEM,
            ):
                after["on"] = states.contains(Atspi.StateType.CHECKED)
        except GLib.Error:
            pass  # the control went away with the window it closed
        return after

    def fill(
        self,
        pid: int,
        title: str,
        name: str,
        number: int | None,
        text: str,
        rehearse: bool,
    ) -> dict[str, Any]:
        node = self._find(pid, title, name, number, fields=True)
        role = node.get_role()
        label = self._label(node)[:120]
        if role == Atspi.Role.PASSWORD_TEXT:
            raise Refused(
                "That is a password field. She does not type passwords; Captain does."
            )
        # Filling in replaces everything that was there. For a one-line field that is the
        # point; for a document it would wipe the user's work.
        if self._states(node).contains(Atspi.StateType.MULTI_LINE) or role in (
            Atspi.Role.DOCUMENT_TEXT,
            Atspi.Role.PARAGRAPH,
        ):
            raise Refused(
                f'"{label}" is a document or a large text box, not a field. Filling it in would replace everything in it. To add text there, click in it and use type.'
            )
        if node.get_editable_text_iface() is None:
            raise Refused(
                f'The field "{label}" cannot be filled in this way. Click it and use type instead.'
            )
        if rehearse:
            return {"filled": label, "rehearsed": True}
        still_wanted()
        if not Atspi.EditableText.set_text_contents(node, text):
            count = (
                Atspi.Text.get_character_count(node)
                if node.get_text_iface() is not None
                else 0
            )
            if count:
                Atspi.EditableText.delete_text(node, 0, count)
            if not Atspi.EditableText.insert_text(node, 0, text, len(text.encode())):
                raise Refused(f'The field "{label}" would not take the text.')
        time.sleep(0.15)
        return {"filled": label, "now": self._value(node, role) or ""}


# ---------------------------------------------------------------- window watch

WATCH_PATH = "/Watch"
WATCH_INTERFACE = "moe.aichan.Watch"
WATCH_XML = f"""
<node>
  <interface name="{WATCH_INTERFACE}">
    <method name="Seen"><arg type="s" name="what" direction="in"/></method>
  </interface>
</node>
"""


class WindowWatch:
    """Receives the window manager's word on which window is in front."""

    def __init__(self) -> None:
        self.connection: Any = None
        self.registration: int = 0

    def start(self) -> str:
        if not HAVE_GI:
            raise Refused(
                "Following the window in front needs python-gobject, which is not installed."
            )
        if self.connection is None:
            self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        if not self.registration:
            info = Gio.DBusNodeInfo.new_for_xml(WATCH_XML)
            self.registration = self.connection.register_object(
                WATCH_PATH, info.interfaces[0], self._called, None, None
            )
        return self.connection.get_unique_name()

    def _from_window_manager(self, sender: str) -> bool:
        """True when the caller is the window manager. Any program on the session bus can
        call this object; only the window manager's word on what is in front is taken."""
        try:
            owner = self.connection.call_sync(
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "GetNameOwner",
                GLib.Variant("(s)", ("org.kde.KWin",)),
                None,
                Gio.DBusCallFlags.NONE,
                1000,
                None,
            ).unpack()[0]
        except GLib.Error:
            return False
        return bool(owner) and owner == sender

    def _called(
        self,
        _connection: Any,
        sender: str,
        _path: str,
        _interface: str,
        method: str,
        parameters: Any,
        invocation: Any,
    ) -> None:
        if method == "Seen" and self._from_window_manager(sender):
            try:
                seen = json.loads(parameters.unpack()[0])
                if isinstance(seen, dict):
                    say({"event": "window", "seen": seen})
            except (ValueError, TypeError):
                pass
        invocation.return_value(None)

    def stop(self) -> None:
        if self.connection is not None and self.registration:
            self.connection.unregister_object(self.registration)
        self.registration = 0


# ---------------------------------------------------------------- the conversation with the app

virtual_input = VirtualInput()
controls = Controls()
window_watch = WindowWatch()


def number_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def handle(request: dict[str, Any]) -> dict[str, Any]:
    op = request.get("op")
    rehearse = bool(request.get("rehearse"))
    given_pid = request.get("pid")
    pid: int = given_pid if isinstance(given_pid, int) else -1
    title = str(request.get("title") or "")
    name = str(request.get("name") or "")
    if op == "hello":
        return {
            "controls": HAVE_GI,
            "controlsProblem": GI_PROBLEM,
            "input": os.access("/dev/uinput", os.W_OK),
        }
    if op == "controls":
        return controls.list(pid, title, name)
    if op == "press":
        return controls.press(
            pid, title, name, number_or_none(request.get("which")), rehearse
        )
    if op == "fill":
        return controls.fill(
            pid,
            title,
            name,
            number_or_none(request.get("which")),
            str(request.get("text") or ""),
            rehearse,
        )
    if op == "pointer":
        x, y = float(request.get("x", -1)), float(request.get("y", -1))
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise Refused("That spot is not on the screen.")
        if not rehearse:
            still_wanted()
            virtual_input.move(x, y)
            if request.get("button"):
                virtual_input.click(
                    str(request["button"]), int(request.get("clicks", 1))
                )
        return {"rehearsed": rehearse}
    if op == "scroll":
        if not rehearse:
            still_wanted()
            virtual_input.scroll(int(request.get("notches", 0)))
        return {"rehearsed": rehearse}
    if op == "key":
        combo = request.get("keys")
        if not isinstance(combo, list):
            raise Refused("No keys were given.")
        if not rehearse:
            still_wanted()
            virtual_input.keys(
                [str(key) for key in combo], int(request.get("times", 1))
            )
        return {"rehearsed": rehearse}
    if op == "arm":
        # Makes the virtual pointer and keyboard without moving or pressing anything.
        virtual_input.arm()
        return {
            "pointer": "AI-chan virtual pointer",
            "keyboard": "AI-chan virtual keyboard",
        }
    if op == "watch":
        return {
            "bus": window_watch.start(),
            "path": WATCH_PATH,
            "interface": WATCH_INTERFACE,
        }
    if op == "unwatch":
        window_watch.stop()
        return {}
    if op == "rest":
        # Lets go of everything that touches the desktop, but stays for the next request.
        virtual_input.close()
        controls.switch_off()
        return {}
    raise Refused(f'Unknown request "{op}".')


def answer(line: str) -> None:
    line = line.strip()
    if not line:
        return
    request_id: Any = None
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise TypeError("not an object")
        request_id = request.get("id")
        global deadline  # one request is handled at a time
        given = request.get("deadline")
        deadline = float(given) if isinstance(given, (int, float)) else 0.0
        still_wanted()
        result = handle(request)
        # The app is told whether the accessibility switch is on by her doing, so it can
        # put the switch back should this helper ever die without tidying up.
        say(
            {"id": request_id, "ok": True, "switchOn": controls.enabled_by_us, **result}
        )
    except Refused as refusal:
        say({"id": request_id, "ok": False, "error": str(refusal)})
    except Exception as error:  # noqa: BLE001 - one bad step must not end the helper
        say(
            {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}
        )


def shut_down() -> None:
    virtual_input.close()
    controls.switch_off()
    window_watch.stop()


def main() -> None:
    if HAVE_GI:
        loop = GLib.MainLoop()
        pending = b""

        def on_input(_source: Any, condition: Any) -> bool:
            nonlocal pending
            if condition & (GLib.IO_HUP | GLib.IO_ERR) and not condition & GLib.IO_IN:
                loop.quit()
                return False
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                loop.quit()
                return False
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                answer(line.decode("utf-8", "replace"))
            return True

        GLib.io_add_watch(
            sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_input
        )
        try:
            loop.run()
        finally:
            shut_down()
    else:
        try:
            for line in sys.stdin:
                answer(line)
        finally:
            shut_down()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        shut_down()
