using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AstraNavi.WinHands;

internal sealed record RpcRequest(string? id, string? verb, JsonElement? payload);

internal sealed record RpcResponse(string id, bool ok, string? data, string? error);

internal sealed record PingResult(bool alive, string platform, string arch, bool nativeAot);

internal sealed record VersionResult(string name, string version, string platform);

internal sealed record WindowRectItem(
    string id,
    string title,
    string app,
    bool active,
    bool minimized,
    int pid,
    bool fullScreen,
    bool dialog,
    double dpiScale,
    int x,
    int y,
    int width,
    int height);

internal sealed record DesktopLayoutResult(WindowRectItem[] windows, int width, int height);

internal sealed record WindowAtResult(string id, string app, string title);

internal sealed record VramStatusResult(
    long totalBytes,
    long freeBytes,
    double? utilizationPercent,
    string source);

internal sealed record GameStateResult(
    int code,
    string state,
    string process,
    long? vramTotalBytes,
    long? vramFreeBytes,
    string? vramSource);

internal sealed record VolumeStateResult(int percent, bool muted);

internal sealed record AudioStreamResult(string id, string app, string mediaName);

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(RpcRequest))]
[JsonSerializable(typeof(RpcResponse))]
[JsonSerializable(typeof(PingResult))]
[JsonSerializable(typeof(VersionResult))]
[JsonSerializable(typeof(DesktopLayoutResult))]
[JsonSerializable(typeof(WindowAtResult))]
[JsonSerializable(typeof(VramStatusResult))]
[JsonSerializable(typeof(GameStateResult))]
[JsonSerializable(typeof(VolumeStateResult))]
[JsonSerializable(typeof(AudioStreamResult[]))]
internal partial class WinHandsJsonContext : JsonSerializerContext;

internal static class Program
{
    public static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        if (args.Length > 0 && args[0] == "--serve")
        {
            return RunServeLoop();
        }

        if (args.Length == 0)
        {
            Console.Error.WriteLine("Usage: win-hands [--serve | <verb>]");
            return 2;
        }

        var verb = args[0];
        var rawStdin = SkipsStdinRead(verb) ? string.Empty : Console.In.ReadToEnd();
        using var doc = ParsePayloadDocument(rawStdin);
        try
        {
            var data = DispatchVerb(verb, doc.RootElement);
            Console.Write(data);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static bool SkipsStdinRead(string verb) =>
        verb is "ping"
            or "version"
            or "wasapi-capture"
            or "notices-monitor"
            or "volume-get"
            or "gpu-vram"
            or "layout"
            or "game-state"
            or "clipboard-read"
            or "wasapi-check"
            or "wasapi-streams";

    private static JsonDocument ParsePayloadDocument(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return JsonDocument.Parse("{}");
        return JsonDocument.Parse(raw);
    }

    private static int RunServeLoop()
    {
        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            string reqId = "";
            try
            {
                var req = JsonSerializer.Deserialize(line, WinHandsJsonContext.Default.RpcRequest);
                reqId = req?.id ?? "";
                var verb = req?.verb ?? "";
                var payload = req?.payload ?? JsonDocument.Parse("{}").RootElement;
                if (string.IsNullOrWhiteSpace(verb))
                {
                    WriteRpc(new RpcResponse(reqId, false, null, "Missing verb."));
                    continue;
                }
                var data = DispatchVerb(verb, payload);
                WriteRpc(new RpcResponse(reqId, true, data, null));
            }
            catch (Exception ex)
            {
                WriteRpc(new RpcResponse(reqId, false, null, ex.Message));
            }
        }
        return 0;
    }

    private static void WriteRpc(RpcResponse response)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(response, WinHandsJsonContext.Default.RpcResponse));
        Console.Out.Flush();
    }

    private static string DispatchVerb(string verb, JsonElement payload)
    {
        switch (verb)
        {
            case "ping":
            {
                var info = new PingResult(
                    true,
                    OperatingSystem.IsWindows() ? "win32" : Environment.OSVersion.Platform.ToString().ToLowerInvariant(),
                    RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
                    true);
                return JsonSerializer.Serialize(info, WinHandsJsonContext.Default.PingResult);
            }
            case "version":
            {
                var ver = new VersionResult(
                    "win-hands-native",
                    "0.1.0",
                    OperatingSystem.IsWindows() ? "win32" : Environment.OSVersion.Platform.ToString().ToLowerInvariant());
                return JsonSerializer.Serialize(ver, WinHandsJsonContext.Default.VersionResult);
            }
            case "controls":
            case "press":
            case "fill":
                throw new InvalidOperationException("UIA_FALLBACK");
        }

        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException($"Win32 verb '{verb}' requires Windows.");
        }

        return Win32Bridge.Dispatch(verb, payload);
    }
}

[SupportedOSPlatform("windows")]
internal static class Win32Bridge
{
    private const uint MouseEventMove = 0x0001;
    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;
    private const uint MouseEventRightDown = 0x0008;
    private const uint MouseEventRightUp = 0x0010;
    private const uint MouseEventMiddleDown = 0x0020;
    private const uint MouseEventMiddleUp = 0x0040;
    private const uint MouseEventWheel = 0x0800;
    private const uint MouseEventVirtualDesk = 0x4000;
    private const uint MouseEventAbsolute = 0x8000;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;
    private const uint PwRenderFullContent = 0x00000002;
    private const uint WmClose = 0x0010;
    private const uint CfUnicodeText = 13;
    private const uint GmemMoveable = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, char[] text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint count, INPUT[] inputs, int structSize);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern bool LockWorkStation();

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int width, int height);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(
        IntPtr hdcDest,
        int xDest,
        int yDest,
        int width,
        int height,
        IntPtr hdcSrc,
        int xSrc,
        int ySrc,
        uint rop);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(
        IntPtr hdc,
        IntPtr hbm,
        uint start,
        uint cLines,
        byte[] bits,
        ref BITMAPINFOHEADER header,
        uint usage);

    [DllImport("user32.dll")]
    private static extern bool OpenClipboard(IntPtr newOwner);

    [DllImport("user32.dll")]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll")]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll")]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll")]
    private static extern IntPtr SetClipboardData(uint format, IntPtr hMem);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalAlloc(uint flags, nuint bytes);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);

    [DllImport("winmm.dll")]
    private static extern int waveOutGetVolume(IntPtr hwo, out uint volume);

    [DllImport("winmm.dll")]
    private static extern int waveOutSetVolume(IntPtr hwo, uint volume);

    public static string Dispatch(string verb, JsonElement payload) => verb switch
    {
        "game-state" => HandleGameState(),
        "gpu-vram" => HandleGpuVram(),
        "lock" => LockWorkStation() ? "true" : "false",
        "layout" => HandleLayout(),
        "window-at" => HandleWindowAt(payload),
        "act" => HandleAct(payload),
        "pointer" => HandlePointer(payload),
        "keys" => HandleKeys(payload),
        "type" => HandleType(payload),
        "scroll" => HandleScroll(payload),
        "capture" => HandleCapture(payload),
        "clipboard-read" => ReadClipboardText(),
        "clipboard-write" => WriteClipboardText(GetString(payload, "text")),
        "volume-get" => HandleVolumeGet(),
        "volume-set" => HandleVolumeSet(payload),
        "volume-mute" => HandleVolumeMute(payload),
        "media-control" => HandleMediaControl(payload),
        "wasapi-check" => "true",
        "wasapi-streams" => HandleWasapiStreams(),
        _ => throw new InvalidOperationException($"Unsupported Win32 bridge verb: {verb}"),
    };

    private static string HandleGameState()
    {
        _ = SHQueryUserNotificationState(out int code);
        string stateName = code switch
        {
            2 => "QUNS_BUSY",
            3 => "QUNS_RUNNING_D3D_FULL_SCREEN",
            4 => "QUNS_PRESENTATION_MODE",
            _ => "QUNS_ACCEPTS_NOTIFICATIONS",
        };
        var fg = GetForegroundWindow();
        _ = GetWindowThreadProcessId(fg, out uint pid);
        string procName = TryProcessName((int)pid);
        var vram = QueryNvidiaVram();
        var result = new GameStateResult(
            code,
            stateName,
            procName,
            vram?.totalBytes,
            vram?.freeBytes,
            vram?.source);
        return JsonSerializer.Serialize(result, WinHandsJsonContext.Default.GameStateResult);
    }

    private static string HandleGpuVram()
    {
        var vram = QueryNvidiaVram();
        return vram is null
            ? "null"
            : JsonSerializer.Serialize(vram, WinHandsJsonContext.Default.VramStatusResult);
    }

    private static VramStatusResult? QueryNvidiaVram()
    {
        try
        {
            using var proc = Process.Start(new ProcessStartInfo
            {
                FileName = "nvidia-smi",
                Arguments = "--query-gpu=memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (proc is null) return null;
            string line = proc.StandardOutput.ReadLine() ?? "";
            proc.WaitForExit(2000);
            if (proc.ExitCode != 0 || string.IsNullOrWhiteSpace(line)) return null;
            var parts = line.Split(',');
            if (parts.Length < 2) return null;
            const long mib = 1024L * 1024L;
            if (!long.TryParse(parts[0].Trim(), out long totalMb)) return null;
            if (!long.TryParse(parts[1].Trim(), out long freeMb)) return null;
            double? util = parts.Length >= 3 && double.TryParse(parts[2].Trim(), out double u) ? u : null;
            return new VramStatusResult(totalMb * mib, freeMb * mib, util, "nvml");
        }
        catch
        {
            return null;
        }
    }

    private static string HandleLayout()
    {
        var fg = GetForegroundWindow();
        var items = new List<WindowRectItem>();
        var titleBuf = new char[512];

        EnumWindows((hwnd, lParam) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            int len = GetWindowText(hwnd, titleBuf, titleBuf.Length);
            if (len <= 0) return true;
            if (!GetWindowRect(hwnd, out var rect)) return true;
            int w = rect.Right - rect.Left;
            int h = rect.Bottom - rect.Top;
            if (w <= 0 || h <= 0) return true;

            _ = GetWindowThreadProcessId(hwnd, out uint pid);
            uint dpi = 96;
            try
            {
                dpi = GetDpiForWindow(hwnd);
            }
            catch
            {
                dpi = 96;
            }
            double dpiScale = dpi > 0 ? Math.Round(dpi / 96.0, 3) : 1.0;

            items.Add(new WindowRectItem(
                hwnd.ToInt64().ToString(),
                new string(titleBuf, 0, len),
                TryProcessName((int)pid),
                hwnd == fg,
                IsIconic(hwnd),
                (int)pid,
                false,
                false,
                dpiScale,
                rect.Left,
                rect.Top,
                w,
                h));
            return true;
        }, IntPtr.Zero);

        int deskW = Math.Max(1, GetSystemMetrics(78)); // SM_CXVIRTUALSCREEN
        int deskH = Math.Max(1, GetSystemMetrics(79)); // SM_CYVIRTUALSCREEN
        return JsonSerializer.Serialize(
            new DesktopLayoutResult(items.ToArray(), deskW, deskH),
            WinHandsJsonContext.Default.DesktopLayoutResult);
    }

    private static string HandleWindowAt(JsonElement payload)
    {
        int x = GetInt(payload, "x");
        int y = GetInt(payload, "y");
        var raw = WindowFromPoint(new POINT { X = x, Y = y });
        if (raw == IntPtr.Zero) return "null";
        var root = GetAncestor(raw, 2); // GA_ROOT
        if (root == IntPtr.Zero) root = raw;
        var titleBuf = new char[512];
        int len = GetWindowText(root, titleBuf, titleBuf.Length);
        _ = GetWindowThreadProcessId(root, out uint pid);
        var res = new WindowAtResult(
            root.ToInt64().ToString(),
            TryProcessName((int)pid),
            len > 0 ? new string(titleBuf, 0, len) : "");
        return JsonSerializer.Serialize(res, WinHandsJsonContext.Default.WindowAtResult);
    }

    private static string HandleAct(JsonElement payload)
    {
        if (!long.TryParse(GetString(payload, "id"), out long handle)) return "false";
        var hwnd = new IntPtr(handle);
        string action = GetString(payload, "action");
        bool ok = action switch
        {
            "focus" => SetForegroundWindow(hwnd),
            "minimize" => ShowWindow(hwnd, 6),
            "maximize" => ShowWindow(hwnd, 3),
            "close" => PostMessage(hwnd, WmClose, IntPtr.Zero, IntPtr.Zero),
            _ => false,
        };
        return ok ? "true" : "false";
    }

    private static string HandlePointer(JsonElement payload)
    {
        string expected = GetString(payload, "expectedWindowId");
        if (!string.IsNullOrEmpty(expected))
        {
            var fg = GetForegroundWindow().ToInt64().ToString();
            if (fg != expected) throw new InvalidOperationException("Foreground window changed before SendInput.");
        }

        int vx = GetSystemMetrics(76);
        int vy = GetSystemMetrics(77);
        int vw = Math.Max(1, GetSystemMetrics(78));
        int vh = Math.Max(1, GetSystemMetrics(79));
        double nx = GetDouble(payload, "x");
        double ny = GetDouble(payload, "y");
        int px = (int)Math.Round(nx * vw) + vx;
        int py = (int)Math.Round(ny * vh) + vy;
        int dx = Math.Clamp((int)Math.Round(((px - vx) * 65535.0) / vw), 0, 65535);
        int dy = Math.Clamp((int)Math.Round(((py - vy) * 65535.0) / vh), 0, 65535);

        int size = Marshal.SizeOf<INPUT>();
        var move = new INPUT[1];
        move[0].type = 0;
        move[0].u.mi.dx = dx;
        move[0].u.mi.dy = dy;
        move[0].u.mi.dwFlags = MouseEventAbsolute | MouseEventVirtualDesk | MouseEventMove;
        _ = SendInput(1, move, size);

        string button = GetString(payload, "button");
        if (!string.IsNullOrEmpty(button))
        {
            uint down = button switch { "right" => MouseEventRightDown, "middle" => MouseEventMiddleDown, _ => MouseEventLeftDown };
            uint up = button switch { "right" => MouseEventRightUp, "middle" => MouseEventMiddleUp, _ => MouseEventLeftUp };
            int clicks = Math.Max(1, GetInt(payload, "clicks", 1));
            for (int c = 0; c < clicks; c++)
            {
                var click = new INPUT[2];
                click[0].type = 0;
                click[0].u.mi.dwFlags = down;
                click[1].type = 0;
                click[1].u.mi.dwFlags = up;
                _ = SendInput(2, click, size);
            }
        }
        return "true";
    }

    private static string HandleKeys(JsonElement payload)
    {
        var vks = new List<ushort>();
        if (payload.TryGetProperty("keys", out var keysProp) && keysProp.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in keysProp.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) continue;
                ushort vk = ResolveVk(item.GetString() ?? "");
                if (vk > 0) vks.Add(vk);
            }
        }
        if (vks.Count > 0)
        {
            int times = Math.Clamp(GetInt(payload, "times", 1), 1, 30);
            for (int t = 0; t < times; t++)
            {
                for (int i = 0; i < vks.Count; i++) SendVk(vks[i], false);
                for (int i = vks.Count - 1; i >= 0; i--) SendVk(vks[i], true);
            }
        }
        return "true";
    }

    private static string HandleType(JsonElement payload)
    {
        string text = GetString(payload, "text");
        if (text.Length > 0)
        {
            var inputs = new INPUT[text.Length * 2];
            int idx = 0;
            foreach (char ch in text)
            {
                inputs[idx].type = 1;
                inputs[idx].u.ki.wScan = ch;
                inputs[idx].u.ki.dwFlags = KeyEventUnicode;
                idx++;
                inputs[idx].type = 1;
                inputs[idx].u.ki.wScan = ch;
                inputs[idx].u.ki.dwFlags = KeyEventUnicode | KeyEventKeyUp;
                idx++;
            }
            _ = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        }
        return "true";
    }

    private static string HandleScroll(JsonElement payload)
    {
        int notches = GetInt(payload, "notches");
        var input = new INPUT[1];
        input[0].type = 0;
        input[0].u.mi.dwFlags = MouseEventWheel;
        input[0].u.mi.mouseData = unchecked((uint)(-120 * notches));
        _ = SendInput(1, input, Marshal.SizeOf<INPUT>());
        return "true";
    }

    private static string HandleCapture(JsonElement payload)
    {
        string outPath = GetString(payload, "outPath");
        if (string.IsNullOrWhiteSpace(outPath)) throw new InvalidOperationException("Missing capture outPath.");
        string windowId = GetString(payload, "windowId");

        int w;
        int h;
        int srcX = 0;
        int srcY = 0;
        IntPtr targetHwnd = IntPtr.Zero;
        if (!string.IsNullOrEmpty(windowId) && long.TryParse(windowId, out long rawId))
        {
            targetHwnd = new IntPtr(rawId);
            if (!GetWindowRect(targetHwnd, out var rect))
                throw new InvalidOperationException("Target window unavailable for capture.");
            w = Math.Max(1, rect.Right - rect.Left);
            h = Math.Max(1, rect.Bottom - rect.Top);
        }
        else
        {
            srcX = GetSystemMetrics(76);
            srcY = GetSystemMetrics(77);
            w = Math.Max(1, GetSystemMetrics(78));
            h = Math.Max(1, GetSystemMetrics(79));
        }

        IntPtr screenDc = GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero) throw new InvalidOperationException("Failed to open screen DC.");
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr bitmap = CreateCompatibleBitmap(screenDc, w, h);
        IntPtr old = SelectObject(memDc, bitmap);
        try
        {
            if (targetHwnd != IntPtr.Zero)
            {
                _ = PrintWindow(targetHwnd, memDc, PwRenderFullContent);
            }
            else
            {
                _ = BitBlt(memDc, 0, 0, w, h, screenDc, srcX, srcY, 0x00CC0020);
            }

            var bi = new BITMAPINFOHEADER
            {
                biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = w,
                biHeight = -h, // top-down BGRA
                biPlanes = 1,
                biBitCount = 32,
                biCompression = 0,
            };
            byte[] bgra = new byte[w * h * 4];
            _ = GetDIBits(memDc, bitmap, 0, (uint)h, bgra, ref bi, 0);
            WritePng(outPath, w, h, bgra);
        }
        finally
        {
            _ = SelectObject(memDc, old);
            _ = DeleteObject(bitmap);
            _ = DeleteDC(memDc);
            _ = ReleaseDC(IntPtr.Zero, screenDc);
        }
        return "true";
    }

    private static string ReadClipboardText()
    {
        if (!OpenClipboard(IntPtr.Zero)) return "";
        try
        {
            var hMem = GetClipboardData(CfUnicodeText);
            if (hMem == IntPtr.Zero) return "";
            var ptr = GlobalLock(hMem);
            if (ptr == IntPtr.Zero) return "";
            try
            {
                return Marshal.PtrToStringUni(ptr) ?? "";
            }
            finally
            {
                _ = GlobalUnlock(hMem);
            }
        }
        finally
        {
            _ = CloseClipboard();
        }
    }

    private static string WriteClipboardText(string text)
    {
        if (!OpenClipboard(IntPtr.Zero)) return "false";
        try
        {
            _ = EmptyClipboard();
            byte[] utf16 = Encoding.Unicode.GetBytes(text + "\0");
            var hMem = GlobalAlloc(GmemMoveable, (nuint)utf16.Length);
            if (hMem == IntPtr.Zero) return "false";
            var ptr = GlobalLock(hMem);
            if (ptr == IntPtr.Zero) return "false";
            try
            {
                Marshal.Copy(utf16, 0, ptr, utf16.Length);
            }
            finally
            {
                _ = GlobalUnlock(hMem);
            }
            _ = SetClipboardData(CfUnicodeText, hMem);
            return "true";
        }
        finally
        {
            _ = CloseClipboard();
        }
    }

    private static string HandleVolumeGet()
    {
        int pct = 50;
        if (waveOutGetVolume(IntPtr.Zero, out uint vol) == 0)
        {
            uint left = vol & 0xFFFF;
            pct = (int)Math.Round((left * 100.0) / 65535.0);
        }
        return JsonSerializer.Serialize(new VolumeStateResult(pct, pct == 0), WinHandsJsonContext.Default.VolumeStateResult);
    }

    private static string HandleVolumeSet(JsonElement payload)
    {
        int pct = Math.Clamp(GetInt(payload, "percent", 50), 0, 100);
        uint ch = (uint)Math.Round((pct / 100.0) * 65535.0);
        _ = waveOutSetVolume(IntPtr.Zero, ch | (ch << 16));
        return JsonSerializer.Serialize(new VolumeStateResult(pct, pct == 0), WinHandsJsonContext.Default.VolumeStateResult);
    }

    private static string HandleVolumeMute(JsonElement payload)
    {
        bool muted = GetBool(payload, "muted");
        if (muted) _ = waveOutSetVolume(IntPtr.Zero, 0);
        return JsonSerializer.Serialize(new VolumeStateResult(muted ? 0 : 50, muted), WinHandsJsonContext.Default.VolumeStateResult);
    }

    private static string HandleMediaControl(JsonElement payload)
    {
        ushort vk = GetString(payload, "action") switch
        {
            "play" or "pause" or "play_pause" => 0xB3,
            "next" => 0xB0,
            "previous" => 0xB1,
            _ => 0,
        };
        if (vk > 0)
        {
            SendVk(vk, false);
            SendVk(vk, true);
        }
        return "null";
    }

    private static string HandleWasapiStreams()
    {
        var list = new List<AudioStreamResult>();
        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(proc.MainWindowTitle))
                {
                    list.Add(new AudioStreamResult(proc.Id.ToString(), proc.ProcessName, proc.MainWindowTitle));
                    if (list.Count >= 12) break;
                }
            }
            catch
            {
                // skip protected process metadata
            }
            finally
            {
                proc.Dispose();
            }
        }
        return JsonSerializer.Serialize(list.ToArray(), WinHandsJsonContext.Default.AudioStreamResultArray);
    }

    private static void SendVk(ushort vk, bool keyUp)
    {
        var input = new INPUT[1];
        input[0].type = 1;
        input[0].u.ki.wVk = vk;
        input[0].u.ki.dwFlags = keyUp ? KeyEventKeyUp : 0;
        _ = SendInput(1, input, Marshal.SizeOf<INPUT>());
    }

    private static ushort ResolveVk(string keyName) => keyName.Trim().ToLowerInvariant() switch
    {
        "ctrl" or "control" => 0x11,
        "alt" => 0x12,
        "shift" => 0x10,
        "win" or "super" => 0x5B,
        "enter" or "return" => 0x0D,
        "tab" => 0x09,
        "escape" or "esc" => 0x1B,
        "backspace" => 0x08,
        "delete" => 0x2E,
        "space" => 0x20,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        var s when s.StartsWith('f') && int.TryParse(s[1..], out int fn) && fn is >= 1 and <= 12 => (ushort)(0x6F + fn),
        var s when s.Length == 1 && char.IsAsciiLetterOrDigit(s[0]) => (ushort)char.ToUpperInvariant(s[0]),
        _ => 0,
    };

    private static string TryProcessName(int pid)
    {
        if (pid <= 0) return "app";
        try
        {
            using var proc = Process.GetProcessById(pid);
            return proc.ProcessName;
        }
        catch
        {
            return "app";
        }
    }

    private static string GetString(JsonElement obj, string prop) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(prop, out var val) && val.ValueKind == JsonValueKind.String
            ? val.GetString() ?? ""
            : "";

    private static int GetInt(JsonElement obj, string prop, int fallback = 0)
    {
        if (obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(prop, out var val))
        {
            if (val.ValueKind == JsonValueKind.Number && val.TryGetInt32(out int num)) return num;
            if (val.ValueKind == JsonValueKind.String && int.TryParse(val.GetString(), out int parsed)) return parsed;
        }
        return fallback;
    }

    private static double GetDouble(JsonElement obj, string prop) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(prop, out var val) && val.ValueKind == JsonValueKind.Number
            ? val.GetDouble()
            : 0.0;

    private static bool GetBool(JsonElement obj, string prop) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(prop, out var val) && val.ValueKind == JsonValueKind.True;

    private static void WritePng(string path, int width, int height, byte[] bgra)
    {
        using var fs = File.Create(path);
        fs.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });

        Span<byte> ihdr = stackalloc byte[13];
        BinaryPrimitives.WriteInt32BigEndian(ihdr[0..4], width);
        BinaryPrimitives.WriteInt32BigEndian(ihdr[4..8], height);
        ihdr[8] = 8; // bit depth
        ihdr[9] = 6; // RGBA
        ihdr[10] = 0;
        ihdr[11] = 0;
        ihdr[12] = 0;
        WritePngChunk(fs, "IHDR"u8, ihdr);

        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            byte[] row = new byte[1 + width * 4];
            for (int y = 0; y < height; y++)
            {
                row[0] = 0;
                int srcOff = y * width * 4;
                for (int x = 0; x < width; x++)
                {
                    int s = srcOff + x * 4;
                    int d = 1 + x * 4;
                    row[d] = bgra[s + 2];
                    row[d + 1] = bgra[s + 1];
                    row[d + 2] = bgra[s];
                    row[d + 3] = 255;
                }
                zlib.Write(row, 0, row.Length);
            }
        }
        WritePngChunk(fs, "IDAT"u8, compressed.ToArray());
        WritePngChunk(fs, "IEND"u8, ReadOnlySpan<byte>.Empty);
    }

    private static void WritePngChunk(Stream output, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> len = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, data.Length);
        output.Write(len);
        output.Write(type);
        output.Write(data);
        Span<byte> crcBytes = stackalloc byte[4];
        uint crc = Crc32(type, data);
        BinaryPrimitives.WriteUInt32BigEndian(crcBytes, crc);
        output.Write(crcBytes);
    }

    private static uint Crc32(ReadOnlySpan<byte> header, ReadOnlySpan<byte> data)
    {
        uint crc = 0xFFFFFFFFu;
        foreach (byte b in header) crc = StepCrc(crc, b);
        foreach (byte b in data) crc = StepCrc(crc, b);
        return crc ^ 0xFFFFFFFFu;
    }

    private static uint StepCrc(uint crc, byte b)
    {
        crc ^= b;
        for (int i = 0; i < 8; i++)
        {
            crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return crc;
    }
}
