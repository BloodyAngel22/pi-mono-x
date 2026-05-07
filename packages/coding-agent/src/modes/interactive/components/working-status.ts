import type { Usage } from "@mariozechner/pi-ai";
import { type Component, type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

const SPINNER_FRAMES = ["✶", "✸", "✹", "✺", "✹", "✷"];
const FRAME_INTERVAL_MS = 160;
const PHRASE_INTERVAL_MS = 4000;
const WORKING_PHRASES = [
	"Philosophising...",
	"Cascading...",
	"Thinking through the task...",
	"Reading the room...",
	"Planning the next move...",
	"Following the trail...",
	"Checking assumptions...",
	"Connecting the dots...",
];

function formatElapsed(startTime: number): string {
	const elapsed = Math.floor((Date.now() - startTime) / 1000);
	if (elapsed < 60) return `${elapsed}s`;
	return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return tokens.toString();
	if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
	if (tokens < 1000000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1000000).toFixed(1)}M`;
}

export class WorkingStatusComponent implements Component {
	private startTime = Date.now();
	private lastPhraseChangeTime = Date.now();
	private spinnerFrame = 0;
	private phraseIndex = 0;
	private timer: NodeJS.Timeout | undefined;
	private usage: Usage | undefined;
	private messageOverride: string | undefined;

	constructor(private ui: TUI) {}

	start(message?: string): void {
		this.stop();
		this.startTime = Date.now();
		this.lastPhraseChangeTime = this.startTime;
		this.spinnerFrame = 0;
		this.phraseIndex = 0;
		this.usage = undefined;
		this.messageOverride = message;
		this.timer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			const now = Date.now();
			if (!this.messageOverride && now - this.lastPhraseChangeTime >= PHRASE_INTERVAL_MS) {
				this.phraseIndex = (this.phraseIndex + 1) % WORKING_PHRASES.length;
				this.lastPhraseChangeTime = now;
			}
			this.ui.requestRender();
		}, FRAME_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	setMessage(message?: string): void {
		this.messageOverride = message;
	}

	setUsage(usage: Usage): void {
		this.usage = usage;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const spinner = theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame] ?? "✶");
		const phrase = theme.fg("muted", this.messageOverride ?? WORKING_PHRASES[this.phraseIndex] ?? "Working...");
		const elapsed = formatElapsed(this.startTime);
		const usageTotal = this.usage
			? this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite
			: 0;
		const usageText = usageTotal > 0 ? ` · ↓ ${formatTokens(usageTotal)} tokens` : "";
		const line = ` ${spinner} ${phrase} ${theme.fg("dim", `(${elapsed}${usageText})`)}`;
		return [truncateToWidth(line, width, theme.fg("dim", "..."))];
	}
}
