// Kontrollrummet.exe: the control room on Windows, as Kontrollrummet.app is on a Mac.
//
//   Kontrollrummet.exe               starts the background part if it is not running,
//                                    waits for the server, and opens the board in its own
//                                    app window (Edge or Chrome --app): the Start menu entry.
//   Kontrollrummet.exe --supervise   the background part, started at login from the Startup
//                                    folder: runs the server and the desks from services.json,
//                                    starts again whatever stops, keeps the PC awake. One
//                                    "Kontrollrummet" in Startup apps and Task Manager, the
//                                    parent of node, instead of a PowerShell for each.
//   Kontrollrummet.exe --stop        stops the background part and everything it started.
//
// Compiled by scripts/install-windows.ps1 with the C# compiler in Windows (.NET
// Framework 4, C# 5), with windows/Kontrollrummet.ico as its icon.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public class Service
{
    public string name { get; set; }
    public string log { get; set; }
    public string[] command { get; set; }
}

public static class Program
{
    const string Url = "http://127.0.0.1:4317/";
    const string MutexName = "Local\\Kontrollrummet.Supervisor";

    static string Data
    {
        get
        {
            string d = Environment.GetEnvironmentVariable("CONTROL_ROOM_DATA");
            return string.IsNullOrEmpty(d) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".control-room") : d;
        }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--supervise") return Supervise(args.Length > 1 ? args[1] : Path.Combine(Data, "services.json"));
        if (args.Length > 0 && args[0] == "--stop") return Stop();
        return Open();
    }

    // ------------------------------------------------------------ the window

    static int Open()
    {
        if (!SupervisorRunning())
        {
            Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--supervise") { UseShellExecute = false, CreateNoWindow = true });
        }
        // The server may still be starting: wait for it, a minute at most.
        for (int i = 0; i < 60 && !ServerAnswers(); i++) Thread.Sleep(1000);
        string browser = AppBrowser();
        // The size Kontrollrummet.app opens at; Edge remembers the window after that.
        if (browser != null) Process.Start(new ProcessStartInfo(browser, "--app=" + Url + " --window-size=1480,920") { UseShellExecute = false });
        else Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
        return 0;
    }

    static bool ServerAnswers()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Url);
            req.Timeout = 1500;
            using (var res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode < 500;
        }
        catch (WebException e)
        {
            return e.Response != null;
        }
        catch
        {
            return false;
        }
    }

    /// Edge or Chrome, which open the board as an app window with its own taskbar icon.
    static string AppBrowser()
    {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string c in candidates) if (File.Exists(c)) return c;
        return null;
    }

    static bool SupervisorRunning()
    {
        Mutex m;
        if (Mutex.TryOpenExisting(MutexName, out m)) { m.Dispose(); return true; }
        return false;
    }

    // ------------------------------------------------------------ stop

    static int Stop()
    {
        string pidFile = Path.Combine(Data, "supervisor.pid");
        if (!File.Exists(pidFile)) return 0;
        int pid;
        if (!int.TryParse(File.ReadAllText(pidFile).Trim(), out pid)) return 0;
        // The whole tree: the services die with the job anyway, this is quicker.
        var kill = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F") { UseShellExecute = false, CreateNoWindow = true });
        kill.WaitForExit(10000);
        try { File.Delete(pidFile); } catch { }
        return 0;
    }

    // ------------------------------------------------------------ the background part

    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong a, b, c, d, e, f;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    static IntPtr job = IntPtr.Zero;

    /// Everything started goes when this process goes, however it goes, as a process group with launchd.
    static void MakeJob()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        var info = new ExtendedLimits();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(info, ptr, false);
        SetInformationJobObject(job, 9, ptr, (uint)size); // JobObjectExtendedLimitInformation
        Marshal.FreeHGlobal(ptr);
    }

    static int Supervise(string file)
    {
        bool mine;
        var mutex = new Mutex(true, MutexName, out mine);
        if (!mine) return 0; // already running
        List<Service> services;
        try
        {
            services = new JavaScriptSerializer().Deserialize<List<Service>>(File.ReadAllText(file, Encoding.UTF8));
        }
        catch (Exception e)
        {
            Note(Path.Combine(Data, @"logs\supervisor.log"), "kan inte läsa " + file + ": " + e.Message);
            return 78;
        }
        Directory.CreateDirectory(Path.Combine(Data, "logs"));
        File.WriteAllText(Path.Combine(Data, "supervisor.pid"), Process.GetCurrentProcess().Id.ToString());
        // Awake while it runs (ES_CONTINUOUS | ES_SYSTEM_REQUIRED), as caffeinate on a Mac.
        SetThreadExecutionState(0x80000001);
        MakeJob();
        var threads = new List<Thread>();
        foreach (Service s in services)
        {
            Service service = s;
            var t = new Thread(() => Run(service)) { IsBackground = true, Name = service.name };
            t.Start();
            threads.Add(t);
        }
        foreach (Thread t in threads) t.Join();
        GC.KeepAlive(mutex);
        return 0;
    }

    /// One service: start it, wait for it, start it again. A quick crash waits 30 s, as launchd's throttle.
    static void Run(Service s)
    {
        while (true)
        {
            DateTime started = DateTime.Now;
            int code = -1;
            try
            {
                var info = new ProcessStartInfo(s.command[0], Arguments(s.command)) { UseShellExecute = false, CreateNoWindow = true };
                using (var p = Process.Start(info))
                {
                    AssignProcessToJobObject(job, p.Handle);
                    p.WaitForExit();
                    code = p.ExitCode;
                }
            }
            catch (Exception e)
            {
                Note(s.log, s.name + " startade inte: " + e.Message);
            }
            int delay = (DateTime.Now - started).TotalSeconds < 30 ? 30 : 2;
            Note(s.log, string.Format("{0} stannade (kod {1}). Startar igen om {2} s.", s.name, code, delay));
            Thread.Sleep(delay * 1000);
        }
    }

    /// The arguments after the program, quoted the way Windows programs read them back.
    static string Arguments(string[] command)
    {
        var sb = new StringBuilder();
        for (int i = 1; i < command.Length; i++)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(Quote(command[i]));
        }
        return sb.ToString();
    }

    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1);
            else sb.Append('\\', slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2);
        return sb.Append('"').ToString();
    }

    static readonly object noteLock = new object();

    static void Note(string log, string text)
    {
        lock (noteLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(log));
                File.AppendAllText(log, DateTime.Now.ToString("s") + " Kontrollrummet: " + text + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { }
        }
    }
}
