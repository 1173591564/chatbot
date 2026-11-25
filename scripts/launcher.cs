using System.Diagnostics;
using System.IO;
using System.Reflection;

static class Launcher
{
    static void Main()
    {
        var dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        var ps1 = Path.Combine(dir, "start-web.ps1");
        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + ps1 + "\"",
            WindowStyle = ProcessWindowStyle.Hidden,
            CreateNoWindow = true,
            UseShellExecute = false
        });
    }
}
