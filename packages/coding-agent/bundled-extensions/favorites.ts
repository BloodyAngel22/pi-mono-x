import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { Input, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const FAVORITES_FILE = path.join(homedir(), ".pi", "agent", "favorites.json");
const FAVORITES_BACKUP = path.join(homedir(), ".pi", "agent", "favorites.json.bak");

// ─── Types ────────────────────────────────────────────────────────────────────

export type FavoriteEntry = { provider: string; id: string };

type DisplayItem =
  | { type: "section"; label: string }
  | { type: "provider"; label: string }
  | { type: "model"; model: Model<any> };

// ─── Storage ──────────────────────────────────────────────────────────────────

function isNewFormat(data: unknown): data is FavoriteEntry[] {
  return (
    Array.isArray(data) &&
    (data.length === 0 ||
      (typeof (data[0] as any)?.provider === "string" &&
        typeof (data[0] as any)?.id === "string"))
  );
}

export function loadFavorites(): FavoriteEntry[] {
  try {
    if (!fs.existsSync(FAVORITES_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(FAVORITES_FILE, "utf-8"));
    if (isNewFormat(raw)) return raw;
    // Old format (string[]): backup and return empty — migration happens in command handler
    return [];
  } catch (e) {
    console.log(`[Favorites] Load error: ${e}`);
    return [];
  }
}

export function saveFavorites(favorites: FavoriteEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(FAVORITES_FILE), { recursive: true });
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2));
  } catch (e) {
    console.log(`[Favorites] Save error: ${e}`);
  }
}

function backupAndMigrate(allModels: Model<any>[], defaultProvider: string): FavoriteEntry[] {
  try {
    if (!fs.existsSync(FAVORITES_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(FAVORITES_FILE, "utf-8"));
    if (isNewFormat(raw)) return raw; // already new format

    // Backup old file
    fs.copyFileSync(FAVORITES_FILE, FAVORITES_BACKUP);

    // Migrate: map old string IDs to {provider, id}
    const oldIds = raw as string[];
    const migrated: FavoriteEntry[] = [];
    for (const oldId of oldIds) {
      const matches = allModels.filter((m) => m.id === oldId);
      if (matches.length === 0) continue;
      // Prefer defaultProvider if multiple providers have this model
      const best =
        matches.find((m) => m.provider === defaultProvider) ??
        matches.find((m) => m.provider === "omniroute") ??
        matches[0]!;
      migrated.push({ provider: best.provider, id: best.id });
    }
    return migrated;
  } catch (e) {
    console.log(`[Favorites] Migration error: ${e}`);
    return [];
  }
}

// ─── Selector UI ──────────────────────────────────────────────────────────────

class FavoritesSelector {
  private displayItems: DisplayItem[] = [];
  private selectedIndex: number = -1;
  private searchMode: boolean = false;
  private searchQuery: string = "";
  private inputComponent: Input;
  private ui: any;
  public onSelect?: (model: Model<any>) => void;
  public onClose?: () => void;
  public width: number = 80;

  constructor(
    private models: Model<any>[],
    private favorites: FavoriteEntry[],
    private theme: any,
    public currentModelId?: string,
  ) {
    this.inputComponent = new Input(theme);
    this.invalidate();
  }

  setUI(ui: any) { this.ui = ui; }
  setTheme(theme: any) { this.theme = theme; }

  // ── Input handling ──

  handleInput(data: string): void {
    if (this.searchMode) {
      this.inputComponent.handleInput(data);
      const input = this.inputComponent.getValue();
      if (matchesKey(data, Key.escape)) {
        this.searchMode = false;
        this.inputComponent.setValue("");
        this.searchQuery = "";
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        this.searchMode = false;
        this.inputComponent.setValue(this.searchQuery);
        this.ensureValidSelection();
      } else {
        this.searchQuery = input.toLowerCase();
        this.invalidate();
      }
      this.ui?.requestRender();
      return;
    }

    if (matchesKey(data, Key.up))       { this.moveSelection(-1); }
    else if (matchesKey(data, Key.down)) { this.moveSelection(1); }
    else if (matchesKey(data, Key.pageUp))   { for (let i = 0; i < 10; i++) this.moveSelection(-1); }
    else if (matchesKey(data, Key.pageDown)) { for (let i = 0; i < 10; i++) this.moveSelection(1); }
    else if (matchesKey(data, Key.home)) { this.selectedIndex = -1; this.moveSelection(1); }
    else if (matchesKey(data, Key.end))  { this.selectedIndex = this.displayItems.length; this.moveSelection(-1); }
    else if (matchesKey(data, Key.enter)) {
      const item = this.displayItems[this.selectedIndex];
      if (item?.type === "model") { this.onSelect?.(item.model); return; }
    } else if (matchesKey(data, Key.escape)) {
      this.onClose?.(); return;
    } else if (data === " " || matchesKey(data, Key.ctrl("f"))) {
      this.toggleFavorite();
      this.invalidate();
    } else if (data === "/") {
      this.searchMode = true;
      this.inputComponent.setValue(this.searchQuery);
    }
    this.ui?.requestRender();
  }

  // ── Navigation ──

  private moveSelection(delta: number): void {
    let newIdx = this.selectedIndex;
    const len = this.displayItems.length;
    if (len === 0) return;
    for (let i = 0; i < len; i++) {
      newIdx = (newIdx + delta + len) % len;
      if (this.displayItems[newIdx]?.type === "model") { this.selectedIndex = newIdx; return; }
    }
  }

  private ensureValidSelection(): void {
    if (this.displayItems.length === 0) { this.selectedIndex = 0; return; }
    if (this.selectedIndex >= this.displayItems.length)
      this.selectedIndex = this.displayItems.length - 1;
    if (this.displayItems[this.selectedIndex]?.type !== "model") {
      this.moveSelection(1);
      if (this.displayItems[this.selectedIndex]?.type !== "model") this.moveSelection(-1);
    }
  }

  // ── Favorites toggle ──

  private isFav(m: Model<any>): boolean {
    return this.favorites.some((f) => f.provider === m.provider && f.id === m.id);
  }

  private toggleFavorite(): void {
    const item = this.displayItems[this.selectedIndex];
    if (item?.type !== "model") return;
    const m = item.model;
    if (this.isFav(m)) {
      this.favorites = this.favorites.filter((f) => !(f.provider === m.provider && f.id === m.id));
    } else {
      this.favorites = [...this.favorites, { provider: m.provider, id: m.id }];
    }
  }

  getFavorites(): FavoriteEntry[] { return this.favorites; }

  // ── Build display list ──

  invalidate(): void {
    const q = this.searchQuery.toLowerCase();
    const filtered = q
      ? this.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q) ||
            (m.name && m.name.toLowerCase().includes(q)),
        )
      : [...this.models];

    // Group favorites by provider
    const favModels = filtered.filter((m) => this.isFav(m));
    const otherModels = filtered.filter((m) => !this.isFav(m));

    const groupByProvider = (models: Model<any>[]): Map<string, Model<any>[]> => {
      const map = new Map<string, Model<any>[]>();
      for (const m of models) {
        const group = map.get(m.provider) ?? [];
        group.push(m);
        map.set(m.provider, group);
      }
      return map;
    };

    this.displayItems = [];

    if (favModels.length > 0) {
      this.displayItems.push({ type: "section", label: "★ Favorites" });
      for (const [prov, ms] of groupByProvider(favModels)) {
        this.displayItems.push({ type: "provider", label: prov });
        ms.forEach((m) => this.displayItems.push({ type: "model", model: m }));
      }
    }

    if (otherModels.length > 0) {
      this.displayItems.push({ type: "section", label: "All Models" });
      for (const [prov, ms] of groupByProvider(otherModels)) {
        this.displayItems.push({ type: "provider", label: prov });
        ms.forEach((m) => this.displayItems.push({ type: "model", model: m }));
      }
    }

    this.ensureValidSelection();
  }

  // ── Render ──

  render(width: number): string[] {
    const lines: string[] = [];
    const w = typeof width === "number" && width > 0 ? width : 80;
    const availWidth = Math.max(20, Math.min(80, w));
    const bdr = (s: string) => this.theme.fg("border", s);
    const inner = availWidth - 2;

    lines.push(bdr("┌" + "─".repeat(inner) + "┐"));
    const titleStr = " Model Selection ";
    const titlePad = Math.max(0, inner - visibleWidth(titleStr));
    lines.push(bdr("│") + this.theme.fg("accent", titleStr) + " ".repeat(titlePad) + bdr("│"));
    lines.push(bdr("├" + "─".repeat(inner) + "┤"));

    const listHeight = 15;
    let startIdx = Math.max(0, this.selectedIndex - Math.floor(listHeight / 2));
    let endIdx = Math.min(this.displayItems.length, startIdx + listHeight);
    if (endIdx - startIdx < listHeight) startIdx = Math.max(0, endIdx - listHeight);

    for (let i = startIdx; i < endIdx; i++) {
      const item = this.displayItems[i];
      if (!item) continue;

      if (item.type === "section") {
        const lbl = ` ${item.label} `;
        const dashes = Math.floor((inner - lbl.length) / 2);
        const line =
          "─".repeat(dashes) + lbl + "─".repeat(Math.max(0, inner - lbl.length - dashes));
        lines.push(bdr("├") + this.theme.fg("accent", line) + bdr("┤"));
        continue;
      }

      if (item.type === "provider") {
        const lbl = ` [${item.label}] `;
        const dashes = Math.max(0, inner - lbl.length);
        const line = lbl + "─".repeat(dashes);
        lines.push(bdr("│") + this.theme.fg("muted", line) + bdr("│"));
        continue;
      }

      // model row
      const m = item.model;
      const isSel = i === this.selectedIndex;
      const isActive = m.id === this.currentModelId;
      const activeMarker = isActive ? "●" : " ";
      const pointer = isSel ? "❯" : " ";
      const favMark = this.isFav(m) ? " ★" : "  ";
      const name = truncateToWidth(m.id, inner - 6, "…");
      const line = `${activeMarker}${pointer}  ${name}${favMark}`;
      const visible = visibleWidth(line);
      const padding = Math.max(0, inner - visible);
      let styledLine =
        isSel
          ? this.theme.inverse(line)
          : isActive
            ? this.theme.fg("accent", line)
            : line;
      lines.push(bdr("│") + styledLine + " ".repeat(padding) + bdr("│"));
    }

    // Fill empty rows
    for (let i = endIdx - startIdx; i < listHeight; i++) {
      lines.push(bdr("│") + " ".repeat(inner) + bdr("│"));
    }

    lines.push(bdr("├" + "─".repeat(inner) + "┤"));
    const helpWidth = inner - 4;

    let helpText = "↑↓ nav  Enter=select  Space/Ctrl+F=★fav  /=search  Esc=close";
    if (this.searchMode) helpText = `Search: ${this.searchQuery}_`;
    const helpLine = truncateToWidth(helpText, helpWidth);
    lines.push(
      bdr("│") + "  " + this.theme.fg("muted", helpLine) +
        " ".repeat(Math.max(0, helpWidth - visibleWidth(helpLine))) + "  " + bdr("│"),
    );

    const modelCount = this.displayItems.filter((it) => it.type === "model").length;
    const pos = `Models: ${modelCount} | Fav: ${this.favorites.length}`;
    const posLine = truncateToWidth(pos, helpWidth);
    lines.push(
      bdr("│") + "  " + " ".repeat(Math.max(0, helpWidth - visibleWidth(posLine))) +
        this.theme.fg("muted", posLine) + "  " + bdr("│"),
    );
    lines.push(bdr("└" + "─".repeat(inner) + "┘"));
    return lines;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("favorites", {
    description: "Open favorites model manager (provider-grouped)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      let allModels: Model<any>[] = [];
      try {
        allModels =
          (ctx.modelRegistry as any).getAvailable
            ? await (ctx.modelRegistry as any).getAvailable()
            : ctx.modelRegistry.getAll();
      } catch {
        allModels = ctx.modelRegistry.getAll();
      }

      if (allModels.length === 0) {
        ctx.ui.notify("No models available in registry", "warning");
        return;
      }

      const settings = (() => {
        try {
          const raw = fs.readFileSync(
            path.join(homedir(), ".pi", "agent", "settings.json"), "utf-8",
          );
          return JSON.parse(raw) as { defaultProvider?: string };
        } catch { return {}; }
      })();
      const defaultProvider = settings.defaultProvider ?? "omniroute";

      // Migrate old format if needed (backup + convert)
      let favorites = backupAndMigrate(allModels, defaultProvider);
      const wasOldFormat = (() => {
        try {
          const raw = JSON.parse(fs.readFileSync(FAVORITES_FILE, "utf-8"));
          return !isNewFormat(raw);
        } catch { return false; }
      })();

      if (wasOldFormat) {
        saveFavorites(favorites);
        ctx.ui.notify(
          `Favorites migrated to new format (${favorites.length} models). Backup: favorites.json.bak`,
          "info",
        );
      } else {
        favorites = loadFavorites();
      }

      const theme = (ctx.ui as any).theme ?? { fg: (_: string, t: string) => t, inverse: (t: string) => t };
      const currentModel = ctx.model;
      const selector = new FavoritesSelector(allModels, favorites, theme, currentModel?.id);

      await ctx.ui.custom(
        (ui: any, _theme: any, _kb: any, close: () => void) => {
          selector.setUI(ui);
          selector.onSelect = async (model: Model<any>) => {
            close();
            try {
              const success = await pi.setModel(model);
              ctx.ui.notify(
                success ? `Active model: [${model.provider}] ${model.id}` : `Failed to switch to ${model.id}`,
                success ? "info" : "error",
              );
            } catch (e) {
              ctx.ui.notify(`Error switching model: ${e}`, "error");
            }
          };
          selector.onClose = () => close();
          return selector;
        },
        { overlay: true },
      );

      const newFavorites = selector.getFavorites();
      saveFavorites(newFavorites);
    },
  });
}
