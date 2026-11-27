// Windows E2E only. Measure WebView2 and its Tauri parent in the same physical pixels.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WindowsWebView {
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
        public override string ToString() { return String.Format("({0},{1})-({2},{3})", Left, Top, Right, Bottom); }
        public bool Matches(Rect r) {
            return Math.Abs(Left - r.Left) <= 1 && Math.Abs(Top - r.Top) <= 1 &&
                   Math.Abs(Right - r.Right) <= 1 && Math.Abs(Bottom - r.Bottom) <= 1;
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }
    private delegate bool EnumProc(IntPtr window, IntPtr arg);
    [DllImport("user32")] private static extern bool EnumThreadWindows(uint thread, EnumProc visit, IntPtr arg);
    [DllImport("user32", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32", SetLastError=true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32")] private static extern bool EnumChildWindows(IntPtr window, EnumProc visit, IntPtr arg);
    [DllImport("user32", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32", SetLastError=true)] private static extern bool ClientToScreen(IntPtr window, ref Point origin);
    [DllImport("user32", SetLastError=true)] private static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32", SetLastError=true)] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32", SetLastError=true)] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int w, int h, uint flags);
    [DllImport("user32", SetLastError=true)] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32")] private static extern uint GetDpiForWindow(IntPtr window);

    private static Rect Client(IntPtr window) {
        Rect rect;
        var origin = new Point();
        if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin))
            throw new Win32Exception();
        rect.Left += origin.X; rect.Right += origin.X;
        rect.Top += origin.Y; rect.Bottom += origin.Y;
        return rect;
    }

    private static void CheckOwner(Process app, IntPtr window, bool allowMinimized = false) {
        uint pid;
        if (app.HasExited || GetWindowThreadProcessId(window, out pid) == 0 || pid != app.Id ||
            !IsWindowVisible(window) || (!allowMinimized && IsIconic(window)))
            throw new InvalidOperationException("The test application no longer owns the expected main window.");
    }

    private static Rect WaitForSurface(Process app, IntPtr window, int width, int height) {
        var timer = Stopwatch.StartNew();
        string detail;
        do {
            CheckOwner(app, window);
            Rect client = Client(window);
            bool foundChromium = false, aligned = true;
            var children = new StringBuilder();
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                if (!IsWindowVisible(child)) return true;
                Rect bounds;
                if (!GetWindowRect(child, out bounds) || bounds.Width <= 0 || bounds.Height <= 0) return true;
                var name = new StringBuilder(128);
                GetClassName(child, name, name.Capacity);
                string cls = name.ToString();
                children.AppendFormat(" {0} {1}", cls, bounds);
                bool isChromium = cls == "Chrome_WidgetWin_0" || cls == "Chrome_WidgetWin_1" || cls == "Chrome_RenderWidgetHostHWND";
                if (cls == "WRY_WEBVIEW" || isChromium) {
                    foundChromium |= isChromium;
                    aligned &= bounds.Matches(client);
                }
                return true;
            }, IntPtr.Zero);
            if (foundChromium && aligned && (width == 0 || (client.Width == width && client.Height == height)))
                return client;
            detail = String.Format("client={0}, requested={1}x{2}, visible children:{3}", client, width, height, children);
            Thread.Sleep(50);
        } while (timer.ElapsedMilliseconds < 3000);
        throw new InvalidOperationException("Unexpected WebView2 window geometry: " + detail);
    }

    public static IntPtr GetMainWindow(Process app, bool allowMinimized = false) {
        app.Refresh();
        var matches = new List<IntPtr>();
        foreach (ProcessThread thread in app.Threads) {
            EnumThreadWindows((uint)thread.Id, delegate(IntPtr h, IntPtr unused) {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid != app.Id || !IsWindowVisible(h)) return true;
                var text = new StringBuilder(128);
                GetWindowText(h, text, text.Capacity);
                if (text.ToString() == "Kazna" || text.ToString() == "P-Treasury") matches.Add(h);
                return true;
            }, IntPtr.Zero);
        }
        if (matches.Count != 1) throw new InvalidOperationException("Expected one visible main window of this test process, found " + matches.Count + ".");
        CheckOwner(app, matches[0], allowMinimized);
        return matches[0];
    }

    public static void CloseMain(Process app) {
        if (!PostMessage(GetMainWindow(app), 0x10 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception();
    }

    public static void SetMinimized(Process app, bool minimize) {
        IntPtr h = GetMainWindow(app, true);
        // WM_SYSCOMMAND with SC_MINIMIZE or SC_RESTORE, like the title-bar buttons.
        if (!PostMessage(h, 0x0112, new IntPtr(minimize ? 0xF020 : 0xF120), IntPtr.Zero))
            throw new Win32Exception();
        for (int i = 0; i < 100; i++) {
            CheckOwner(app, h, true);
            if (IsIconic(h) == minimize) return;
            Thread.Sleep(30);
        }
        throw new TimeoutException("The test window did not reach the requested minimize state.");
    }

    // A zero size only reads and verifies the current client. Width and height are DIPs.
    public static int[] MeasureOrResize(Process app, int width, int height) {
        IntPtr window = GetMainWindow(app);
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        if (previous == IntPtr.Zero) throw new Win32Exception();
        try {
            Rect client = WaitForSurface(app, window, 0, 0);
            uint dpi = GetDpiForWindow(window);
            if (dpi == 0) throw new InvalidOperationException("Cannot read test window DPI.");
            if (width != 0 || height != 0) {
                if (width <= 0 || height <= 0) throw new ArgumentOutOfRangeException("width/height");
                int physicalWidth = (int)Math.Round(width * dpi / 96.0);
                int physicalHeight = (int)Math.Round(height * dpi / 96.0);
                Rect frame;
                if (!GetWindowRect(window, out frame)) throw new Win32Exception();
                // Keep position, z-order and activation. Only the top-level window receives WM_SIZE.
                CheckOwner(app, window);
                if (!SetWindowPos(window, IntPtr.Zero, 0, 0, physicalWidth + frame.Width - client.Width,
                                  physicalHeight + frame.Height - client.Height, 0x0002 | 0x0004 | 0x0010))
                    throw new Win32Exception();
                client = WaitForSurface(app, window, physicalWidth, physicalHeight);
            }
            return new[] { (int)Math.Round(client.Width * 96.0 / dpi), (int)Math.Round(client.Height * 96.0 / dpi) };
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
