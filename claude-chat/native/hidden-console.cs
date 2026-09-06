using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Give CLI children a console that is hidden from its creation. CREATE_NO_WINDOW
// alone leaves them console-less, so grandchildren may create visible consoles.
class HiddenConsole {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb;
        public string reserved, desktop, title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reservedSize;
        public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // Windows CommandLineToArgvW / CRT quoting, including trailing backslashes.
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    static int Main(string[] args) {
        if (args.Length == 0) return 64;
        var command = new StringBuilder();
        foreach (string arg in args) {
            if (command.Length > 0) command.Append(' ');
            command.Append(Quote(arg));
        }
        var startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(startup);
        startup.flags = 0x101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
        startup.show = 0; // SW_HIDE, applied before the console becomes visible
        startup.input = GetStdHandle(-10);
        startup.output = GetStdHandle(-11);
        startup.error = GetStdHandle(-12);
        foreach (var handle in new[] { startup.input, startup.output, startup.error }) {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1))
                SetHandleInformation(handle, 1, 1);
        }
        ProcessInfo child;
        if (!CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, true,
                0x10, IntPtr.Zero, null, ref startup, out child)) { // CREATE_NEW_CONSOLE
            Console.Error.WriteLine(new Win32Exception(Marshal.GetLastWin32Error()).Message);
            return 127;
        }
        CloseHandle(child.thread);
        WaitForSingleObject(child.process, 0xffffffff);
        uint code;
        GetExitCodeProcess(child.process, out code);
        CloseHandle(child.process);
        return unchecked((int)code);
    }
}
