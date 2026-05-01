import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

function spawnDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}

function spawnShell(cmd: string): void {
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}

function wrapForTmux(seq: string): string {
  if (!process.env.TMUX) return seq;
  return `\x1bPtmux;${seq.split("\x1b").join("\x1b\x1b")}\x1b\\`;
}

function notifyLinux(title: string, body: string): void {
  spawnDetached("notify-send", [
    "--app-name", "pi",
    "--expire-time", "5000",
    title,
    body,
  ]);
}

function notifyWindows(title: string, body: string): void {
  const type = "Windows.UI.Notifications";
  const script = [
    `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show([${type}.ToastNotification]::new($xml))`,
  ].join("; ");
  spawnDetached("powershell.exe", ["-NoProfile", "-Command", script]);
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(wrapForTmux(`\x1b]777;notify;${title};${body}\x07`));
}

function notifyOSC9(msg: string): void {
  process.stdout.write(wrapForTmux(`\x1b]9;${msg}\x07`));
}

function notifyOSC99(title: string, body: string): void {
  process.stdout.write(wrapForTmux(`\x1b]99;i=1:d=0;${title}\x1b\\`));
  process.stdout.write(wrapForTmux(`\x1b]99;i=1:p=body;${body}\x1b\\`));
}

const DEFAULT_SOUND = "/usr/share/sounds/freedesktop/stereo/complete.oga";

function runSoundHook(): void {
  const cmd = process.env.PI_NOTIFY_SOUND_CMD?.trim();
  if (cmd) {
    spawnShell(cmd);
    return;
  }
  // Default: paplay with freedesktop complete sound, fall back to terminal bell
  try {
    const child = spawn("paplay", [DEFAULT_SOUND], { detached: true, stdio: "ignore" });
    child.on("error", () => process.stdout.write("\x07"));
    child.unref();
  } catch {
    process.stdout.write("\x07");
  }
}

function sendNotification(title: string, body: string): void {
  const isIterm2 = process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);

  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (process.platform === "linux") {
    notifyLinux(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else if (isIterm2) {
    notifyOSC9(`${title}: ${body}`);
  } else {
    notifyOSC777(title, body);
  }
  runSoundHook();
}

export default function (pi: ExtensionAPI): void {
  pi.on("agent_end", async () => {
    sendNotification("pi", "Ready for input");
  });
}
