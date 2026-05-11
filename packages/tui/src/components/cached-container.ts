import { type Component, Container } from "../tui.js";

type ChildRenderCache = {
	component: Component;
	lines: string[];
};

const LIVE_TAIL_CHILDREN = 8;

/**
 * Container that caches each child's rendered lines between renders.
 * Useful for long, append-only histories where most children are unchanged.
 */
export class CachedContainer extends Container {
	private cachedWidth?: number;
	private childCaches: ChildRenderCache[] = [];
	private renderDirty = true;

	override addChild(component: Component): void {
		super.addChild(component);
		this.renderDirty = true;
	}

	override removeChild(component: Component): void {
		const before = this.children.length;
		super.removeChild(component);
		if (this.children.length !== before) {
			this.renderDirty = true;
		}
	}

	override clear(): void {
		super.clear();
		this.childCaches = [];
		this.renderDirty = true;
	}

	markDirty(): void {
		this.renderDirty = true;
	}

	override invalidate(): void {
		super.invalidate();
		this.childCaches = [];
		this.cachedWidth = undefined;
		this.renderDirty = true;
	}

	override render(width: number): string[] {
		const widthChanged = this.cachedWidth !== width;
		const liveTailStart = Math.max(0, this.children.length - LIVE_TAIL_CHILDREN);
		const nextCaches: ChildRenderCache[] = [];
		const lines: string[] = [];

		for (let i = 0; i < this.children.length; i++) {
			const child = this.children[i];
			const previous = !widthChanged && !this.renderDirty && i < liveTailStart ? this.childCaches[i] : undefined;
			const childLines = previous?.component === child ? previous.lines : child.render(width);
			nextCaches.push({ component: child, lines: childLines });
			for (const line of childLines) {
				lines.push(line);
			}
		}

		this.cachedWidth = width;
		this.childCaches = nextCaches;
		this.renderDirty = false;
		return lines;
	}
}
