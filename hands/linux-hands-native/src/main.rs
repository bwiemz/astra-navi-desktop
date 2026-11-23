use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, Write};
use std::process::{Command, Stdio};

const VERSION: &str = "1.0.0";
const WATCH_PATH: &str = "/app/astranavi/hands/Watch";
const WATCH_INTERFACE: &str = "app.astranavi.HandsWatch";

#[derive(Clone, Debug)]
enum JsonVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsonVal>),
    Obj(HashMap<String, JsonVal>),
}

impl JsonVal {
    fn as_str(&self) -> Option<&str> {
        match self {
            JsonVal::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_f64(&self) -> Option<f64> {
        match self {
            JsonVal::Num(n) => Some(*n),
            _ => None,
        }
    }

    fn as_i64(&self) -> Option<i64> {
        self.as_f64().map(|n| n.trunc() as i64)
    }

    fn as_arr(&self) -> Option<&Vec<JsonVal>> {
        match self {
            JsonVal::Arr(a) => Some(a),
            _ => None,
        }
    }

    fn as_obj(&self) -> Option<&HashMap<String, JsonVal>> {
        match self {
            JsonVal::Obj(o) => Some(o),
            _ => None,
        }
    }
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.bytes.get(self.pos).copied()
    }

    fn parse_value(&mut self) -> Result<JsonVal, String> {
        match self.peek() {
            Some(b'{') => self.parse_obj(),
            Some(b'[') => self.parse_arr(),
            Some(b'"') => self.parse_str().map(JsonVal::Str),
            Some(b't') if self.starts_with(b"true") => {
                self.pos += 4;
                Ok(JsonVal::Bool(true))
            }
            Some(b'f') if self.starts_with(b"false") => {
                self.pos += 5;
                Ok(JsonVal::Bool(false))
            }
            Some(b'n') if self.starts_with(b"null") => {
                self.pos += 4;
                Ok(JsonVal::Null)
            }
            Some(b'-') | Some(b'0'..=b'9') => self.parse_num(),
            Some(c) => Err(format!("unexpected byte '{}'", c as char)),
            None => Err("unexpected EOF".to_string()),
        }
    }

    fn starts_with(&self, pat: &[u8]) -> bool {
        self.bytes.get(self.pos..self.pos + pat.len()) == Some(pat)
    }

    fn parse_str(&mut self) -> Result<String, String> {
        self.skip_ws();
        if self.bytes.get(self.pos) != Some(&b'"') {
            return Err("expected string quote".to_string());
        }
        self.pos += 1;
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            self.pos += 1;
            if b == b'"' {
                return Ok(out);
            }
            if b == b'\\' {
                let esc = *self.bytes.get(self.pos).ok_or("dangling escape")?;
                self.pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\x08'),
                    b'f' => out.push('\x0c'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hex = self
                            .bytes
                            .get(self.pos..self.pos + 4)
                            .ok_or("short unicode escape")?;
                        let s = std::str::from_utf8(hex).map_err(|_| "bad utf8")?;
                        let code = u32::from_str_radix(s, 16).map_err(|_| "bad unicode hex")?;
                        self.pos += 4;
                        if let Some(ch) = char::from_u32(code) {
                            out.push(ch);
                        }
                    }
                    other => out.push(other as char),
                }
            } else {
                // Handle UTF-8 multi-byte slices directly by rewinding and reading chars if high bit set.
                if b < 0x80 {
                    out.push(b as char);
                } else {
                    self.pos -= 1;
                    let tail = std::str::from_utf8(&self.bytes[self.pos..])
                        .map_err(|_| "invalid utf-8 in json string")?;
                    let ch = tail.chars().next().ok_or("empty utf-8 char")?;
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
        Err("unterminated string".to_string())
    }

    fn parse_num(&mut self) -> Result<JsonVal, String> {
        let start = self.pos;
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9' => self.pos += 1,
                _ => break,
            }
        }
        let s = std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| "bad num")?;
        let n = s.parse::<f64>().map_err(|_| "invalid number".to_string())?;
        Ok(JsonVal::Num(n))
    }

    fn parse_arr(&mut self) -> Result<JsonVal, String> {
        self.pos += 1;
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(JsonVal::Arr(items));
        }
        loop {
            items.push(self.parse_value()?);
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(JsonVal::Arr(items));
                }
                _ => return Err("expected ',' or ']'".to_string()),
            }
        }
    }

    fn parse_obj(&mut self) -> Result<JsonVal, String> {
        self.pos += 1;
        let mut map = HashMap::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(JsonVal::Obj(map));
        }
        loop {
            let key = self.parse_str()?;
            if self.peek() != Some(b':') {
                return Err("expected ':'".to_string());
            }
            self.pos += 1;
            let val = self.parse_value()?;
            map.insert(key, val);
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(JsonVal::Obj(map));
                }
                _ => return Err("expected ',' or '}'".to_string()),
            }
        }
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn has_binary(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn run_argv(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{cmd} failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{cmd} exited {}: {}", out.status, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn emit(line: &str) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn id_json(id: Option<&JsonVal>) -> String {
    match id {
        Some(JsonVal::Num(n)) => {
            if (n.fract()).abs() < 1e-9 {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        Some(JsonVal::Str(s)) => json_escape(s),
        _ => "null".to_string(),
    }
}

fn handle_request(req: &HashMap<String, JsonVal>) -> String {
    let id = req.get("id");
    let id_str = id_json(id);
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let rehearse = matches!(req.get("rehearse"), Some(JsonVal::Bool(true)));

    let has_xdotool = has_binary("xdotool");
    let has_ydotool = has_binary("ydotool");
    let has_wtype = has_binary("wtype");
    let has_busctl = has_binary("busctl");
    let has_uinput = std::path::Path::new("/dev/uinput").exists();
    let can_input = has_xdotool || has_ydotool || has_wtype || has_uinput;

    match op {
        "hello" | "abilities" | "ping" => {
            let problem = if has_busctl {
                ""
            } else {
                "busctl is unavailable for D-Bus introspection on this system."
            };
            format!(
                "{{\"id\":{id_str},\"ok\":true,\"switchOn\":false,\"backend\":\"linux-hands-native\",\"version\":{},\"controls\":{has_busctl},\"controlsProblem\":{},\"input\":{can_input}}}",
                json_escape(VERSION),
                json_escape(problem)
            )
        }
        "controls" => {
            let title = req.get("title").and_then(|v| v.as_str()).unwrap_or("");
            format!(
                "{{\"id\":{id_str},\"ok\":true,\"switchOn\":false,\"window\":{},\"controls\":[],\"more\":0,\"text\":[]}}",
                json_escape(title)
            )
        }
        "press" | "fill" => {
            format!("{{\"id\":{id_str},\"ok\":false,\"switchOn\":false,\"error\":\"NOMATCH\"}}")
        }
        "pointer" => {
            let x = req.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = req.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let clicks = req.get("clicks").and_then(|v| v.as_i64()).unwrap_or(0).clamp(0, 3);
            let button = req.get("button").and_then(|v| v.as_str()).unwrap_or("left");
            if rehearse || env::var_os("AI_CHAN_NO_VIRTUAL_INPUT").is_some() {
                return format!(
                    "{{\"id\":{id_str},\"ok\":true,\"switchOn\":false,\"rehearsed\":true,\"x\":{x},\"y\":{y}}}"
                );
            }
            if has_xdotool {
                let px = (x.clamp(0.0, 1.0) * 1920.0).round() as i64;
                let py = (y.clamp(0.0, 1.0) * 1080.0).round() as i64;
                let px_s = px.to_string();
                let py_s = py.to_string();
                let _ = run_argv("xdotool", &["mousemove", &px_s, &py_s]);
                if clicks > 0 {
                    let btn = match button {
                        "right" => "3",
                        "middle" => "2",
                        _ => "1",
                    };
                    let rep = clicks.to_string();
                    if let Err(err) = run_argv("xdotool", &["click", "--repeat", &rep, btn]) {
                        return format!(
                            "{{\"id\":{id_str},\"ok\":false,\"error\":{}}}",
                            json_escape(&err)
                        );
                    }
                }
                return format!(
                    "{{\"id\":{id_str},\"ok\":true,\"switchOn\":false,\"pointer\":\"linux-hands-native\"}}"
                );
            }
            format!(
                "{{\"id\":{id_str},\"ok\":false,\"error\":{}}}",
                json_escape("No native virtual input tool (xdotool/ydotool) available on PATH.")
            )
        }
        "scroll" => {
            let notches = req.get("notches").and_then(|v| v.as_i64()).unwrap_or(0);
            if rehearse || env::var_os("AI_CHAN_NO_VIRTUAL_INPUT").is_some() {
                return format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}");
            }
            if has_xdotool && notches != 0 {
                let btn = if notches > 0 { "5" } else { "4" };
                let rep = notches.abs().min(20).to_string();
                if let Err(err) = run_argv("xdotool", &["click", "--repeat", &rep, btn]) {
                    return format!(
                        "{{\"id\":{id_str},\"ok\":false,\"error\":{}}}",
                        json_escape(&err)
                    );
                }
                return format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}");
            }
            format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}")
        }
        "key" => {
            let keys: Vec<String> = req
                .get("keys")
                .and_then(|v| v.as_arr())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|k| k.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty() && !s.contains([';', '&', '|', '$', '`']))
                        .collect()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                return format!(
                    "{{\"id\":{id_str},\"ok\":false,\"error\":\"Missing keys array.\"}}"
                );
            }
            if rehearse || env::var_os("AI_CHAN_NO_VIRTUAL_INPUT").is_some() {
                return format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}");
            }
            if has_xdotool {
                let combo = keys.join("+");
                let times = req.get("times").and_then(|v| v.as_i64()).unwrap_or(1).clamp(1, 20);
                for _ in 0..times {
                    if let Err(err) = run_argv("xdotool", &["key", &combo]) {
                        return format!(
                            "{{\"id\":{id_str},\"ok\":false,\"error\":{}}}",
                            json_escape(&err)
                        );
                    }
                }
                return format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}");
            }
            if has_wtype {
                let last = keys.last().cloned().unwrap_or_default();
                let _ = run_argv("wtype", &[&last]);
                return format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}");
            }
            format!(
                "{{\"id\":{id_str},\"ok\":false,\"error\":{}}}",
                json_escape("No native key injector (xdotool/wtype) available on PATH.")
            )
        }
        "watch" => format!(
            "{{\"id\":{id_str},\"ok\":true,\"switchOn\":false,\"bus\":\"session\",\"path\":{},\"interface\":{}}}",
            json_escape(WATCH_PATH),
            json_escape(WATCH_INTERFACE)
        ),
        "unwatch" | "rest" => {
            format!("{{\"id\":{id_str},\"ok\":true,\"switchOn\":false}}")
        }
        other => format!(
            "{{\"id\":{id_str},\"ok\":false,\"error\":{}}}",
            json_escape(&format!("Unknown request \"{other}\"."))
        ),
    }
}

fn main() {
    let mut args = env::args().skip(1);
    if let Some(arg) = args.next() {
        match arg.as_str() {
            "ping" => {
                println!("pong");
                return;
            }
            "version" | "--version" | "-V" => {
                println!("linux-hands {VERSION}");
                return;
            }
            _ => {}
        }
    }

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(raw) = line else { break };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        match JsonParser::new(trimmed).parse_value() {
            Ok(val) => {
                if let Some(obj) = val.as_obj() {
                    emit(&handle_request(obj));
                } else {
                    emit("{\"id\":null,\"ok\":false,\"error\":\"Request must be a JSON object.\"}");
                }
            }
            Err(err) => {
                emit(&format!(
                    "{{\"id\":null,\"ok\":false,\"error\":{}}}",
                    json_escape(&err)
                ));
            }
        }
    }
}
