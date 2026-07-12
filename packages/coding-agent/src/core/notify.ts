import { spawn } from "node:child_process";
import type { SettingsManager } from "./settings-manager.js";

// RPC clients that already show their own OS-level notification (e.g. Pi Pine, via a
// native Tauri notification tied to its own UI/tab-focus logic) set this env var when
// spawning `pi --mode rpc` to suppress the visual notification below and avoid a
// duplicate. The sound is NOT gated by this — such clients don't play a sound
// themselves, so the sound should still play regardless of client.
const CLIENT_HANDLES_NOTIFY = process.env.PI_RPC_CLIENT_NOTIFIES === "1";

const DEFAULT_SOUND = "/usr/share/sounds/freedesktop/stereo/complete.oga";

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
	spawnDetached("notify-send", ["--app-name", "pi", "--expire-time", "5000", title, body]);
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

function showVisualNotification(title: string, body: string): void {
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
}

function runSoundHook(settingsManager: SettingsManager): void {
	if (!settingsManager.getNotificationSoundEnabled()) return;
	// Power-user override — takes precedence over the settings-based sound path.
	const cmd = process.env.PI_NOTIFY_SOUND_CMD?.trim();
	if (cmd) {
		spawnShell(cmd);
		return;
	}
	const soundPath = settingsManager.getNotificationSoundPath()?.trim() || DEFAULT_SOUND;
	try {
		const child = spawn("paplay", [soundPath], { detached: true, stdio: "ignore" });
		child.on("error", () => process.stdout.write("\x07"));
		child.unref();
	} catch {
		process.stdout.write("\x07");
	}
}

/** Called once per user request, when the agent goes fully idle (agent_end). */
export function sendAgentEndNotification(settingsManager: SettingsManager): void {
	if (settingsManager.getNotificationEnabled() && !CLIENT_HANDLES_NOTIFY) {
		showVisualNotification("pi", "Ready for input");
	}
	runSoundHook(settingsManager);
}
