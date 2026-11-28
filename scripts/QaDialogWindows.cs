using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class KaznaDialogWindows {
    public delegate bool Visitor(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Visitor visitor, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint relationship);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    public class Item {
        public IntPtr Handle {get;set;} public uint ProcessId {get;set;}
        public string ClassName {get;set;} public string Title {get;set;}
        public uint OwnerId {get;set;}
    }
    private static Item Read(IntPtr h) {
        var title = new StringBuilder(256); var cls = new StringBuilder(256);
        uint process, owner; GetWindowThreadProcessId(h,out process);
        GetWindowThreadProcessId(GetWindow(h,4),out owner);
        GetClassName(h,cls,256); GetWindowText(h,title,256);
        return new Item {Handle=h,Title=title.ToString(),ClassName=cls.ToString(),ProcessId=process,OwnerId=owner};
    }
    public static Item[] All() {
        var result = new List<Item>();
        EnumWindows((h, n) => {
            if (!IsWindowVisible(h)) return true;
            var w=Read(h); result.Add(w);
            EnumChildWindows(h, (child, ignored) => {
                if(IsWindowVisible(child)) {
                    var sub=Read(child);
                    if(sub.ClassName=="#32770") result.Add(sub);
                }
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
