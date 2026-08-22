import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Opens a native folder picker. Returns the selected absolute path, or null
// if the user cancelled. Currently implemented for macOS only via osascript.
export async function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new Error(`Native folder picker not implemented for ${process.platform}`);
  }
  // The osascript prompt lives behind any active app — bringing System Events
  // (or Finder) to the front first makes the dialog reliably visible.
  const script = `
tell application "System Events" to activate
set chosen to choose folder with prompt "Select a repository to open in buildover"
POSIX path of chosen
`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    const path = stdout.trim();
    if (!path) return null;
    // osascript returns POSIX paths with a trailing slash for folders.
    return path.replace(/\/$/, "");
  } catch (err) {
    // Cancelling surfaces as AppleScript error -128. Match the code rather than
    // the message, which is localised ("canceled" vs "cancelled").
    const stderr = String((err as { stderr?: unknown })?.stderr ?? "");
    if (stderr.includes("-128")) return null;
    throw err;
  }
}
