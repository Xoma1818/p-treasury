using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class KaznaDialogWindows {
    public delegate bool Visitor(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Visitor visitor, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd,uint msg,IntPtr wParam,string lParam,uint flags,uint timeout,out IntPtr result);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint relationship);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    public class Item {
        public IntPtr Handle {get;set;} public uint ProcessId {get;set;}
        public string ClassName {get;set;} public string Title {get;set;}
        public uint OwnerId {get;set;} public int ID {get;set;}
    }
    private static Item Read(IntPtr h) {
        var title = new StringBuilder(256); var cls = new StringBuilder(256);
        uint process, owner; GetWindowThreadProcessId(h,out process);
        GetWindowThreadProcessId(GetWindow(h,4),out owner);
        GetClassName(h,cls,256); GetWindowText(h,title,256);
        return new Item {Handle=h,Title=title.ToString(),ClassName=cls.ToString(),ProcessId=process,OwnerId=owner,ID=GetDlgCtrlID(h)};
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
    public static Item[] Controls(IntPtr h) {
        var controls=new List<Item>();
        EnumChildWindows(h,(c,n)=>{if(IsWindowVisible(c)) controls.Add(Read(c));return true;},IntPtr.Zero);
        return controls.ToArray();
    }
    public static IntPtr FileNameEntry(IntPtr dialog) {
        var children=Controls(dialog);
        foreach(var child in children) {
            if(child.ID!=1148 && child.ID!=1152) continue;
            if(child.ClassName=="Edit") return child.Handle;
            foreach(var sub in Controls(child.Handle)) if(sub.ClassName=="Edit") return sub.Handle;
        }
        foreach(var child in children) if(child.ClassName=="Edit" && child.ID==1001) return child.Handle;
        return IntPtr.Zero;
    }
    public static bool TypeName(IntPtr edit, string path) {
        IntPtr accepted; return SendMessageTimeout(edit,0x000C,IntPtr.Zero,path,2,2000,out accepted)!=IntPtr.Zero && accepted!=IntPtr.Zero;
    }
    public static void Action(IntPtr dialog, int id, bool clickButton) {
        IntPtr button=IntPtr.Zero;
        foreach(var c in Controls(dialog)) if(c.ID==id && c.ClassName=="Button") {button=c.Handle;break;}
        if(clickButton && button!=IntPtr.Zero) PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero);
        else PostMessage(dialog,0x0111,new IntPtr(id),button);
    }
}
