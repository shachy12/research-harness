import { spawn } from 'node:child_process';

/**
 * Open the operating system's own "choose a folder" dialog and return the chosen path (null if
 * cancelled). A web page can't learn real folder paths, but this server runs on the user's machine,
 * so it can show the native dialog for the page. (In Electron, `dialog.showOpenDialog` replaces this.)
 *
 *   Windows: the standard Explorer folder dialog (IFileOpenDialog with FOS_PICKFOLDERS), via PowerShell
 *   macOS:   `choose folder` (AppleScript)
 *   Linux:   zenity, or kdialog
 */
export async function pickFolder({ title, startIn }: { title: string; startIn?: string }): Promise<string | null> {
  if (process.platform === 'win32') return pickWindows(title, startIn);
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt ${appleString(title)})`;
    return trimPath(await run('osascript', ['-e', script], { cancelCodes: [1] }));
  }
  try {
    return trimPath(await run('zenity', ['--file-selection', '--directory', `--title=${title}`], { cancelCodes: [1] }));
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  try {
    return trimPath(await run('kdialog', ['--getexistingdirectory', startIn ?? '.', '--title', title], { cancelCodes: [1] }));
  } catch (err) {
    if (isMissing(err)) throw new Error('No folder dialog is available (install zenity or kdialog). Type the path instead.');
    throw err;
  }
}

/** Compile the Windows dialog without showing it (for tests: checks the COM declarations). */
export async function checkWindowsPicker(): Promise<void> {
  await run('powershell.exe', powershellArgs(), { env: { HARNESS_PICK_SHOW: '0', HARNESS_PICK_TITLE: 'test' } });
}

async function pickWindows(title: string, startIn?: string): Promise<string | null> {
  const env = { HARNESS_PICK_SHOW: '1', HARNESS_PICK_TITLE: title, HARNESS_PICK_START: startIn ?? '' };
  return trimPath(await run('powershell.exe', powershellArgs(), { env }));
}

// The dialog's owner is an invisible, topmost window, so the dialog opens in front of the browser.
// Inputs come in through environment variables, so nothing needs quoting.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class HarnessFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, out IShellItem item);

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(string title, string startIn, bool show) {
    var dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    dialog.SetTitle(title);
    dialog.SetOkButtonLabel("Use this folder");
    if (!string.IsNullOrEmpty(startIn)) {
      try {
        var iid = typeof(IShellItem).GUID;
        IShellItem folder;
        SHCreateItemFromParsingName(startIn, IntPtr.Zero, ref iid, out folder);
        dialog.SetFolder(folder);
      } catch { /* start in the default place */ }
    }
    if (!show) return null;

    using (var owner = new Form()) {
      owner.TopMost = true;
      owner.ShowInTaskbar = false;
      owner.FormBorderStyle = FormBorderStyle.None;
      owner.StartPosition = FormStartPosition.CenterScreen;
      owner.Size = new System.Drawing.Size(1, 1);
      owner.Opacity = 0;
      owner.Show();
      owner.Activate();
      if (dialog.Show(owner.Handle) != 0) return null; // cancelled
      IShellItem result;
      dialog.GetResult(out result);
      string path;
      result.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    }
  }
}
'@
$path = [HarnessFolderPicker]::Pick($env:HARNESS_PICK_TITLE, $env:HARNESS_PICK_START, $env:HARNESS_PICK_SHOW -eq '1')
if ($path) { [Console]::Out.Write($path) }
`;

function powershellArgs(): string[] {
  // -EncodedCommand takes UTF-16LE base64, so the script needs no escaping (and no script file,
  // which the execution policy might block).
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

function run(
  command: string,
  args: string[],
  { env = {}, cancelCodes = [] }: { env?: Record<string, string>; cancelCodes?: number[] } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else if (code !== null && cancelCodes.includes(code)) resolve('');
      else reject(new Error(`The folder dialog failed: ${stderr.trim().split('\n').at(-1) || `exit code ${code}`}`));
    });
  });
}

/** The chosen path without a trailing slash (except a drive or filesystem root), or null if none. */
function trimPath(out: string): string | null {
  const p = out.trim();
  if (!p) return null;
  return p === '/' || /^[A-Za-z]:[\\/]$/.test(p) ? p : p.replace(/[\\/]+$/, '');
}
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';
const appleString = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
