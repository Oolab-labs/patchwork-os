import fs from "node:fs";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import {
  type LoadedPlugin,
  type LoadedPluginTool,
  loadOnePluginFull,
} from "./pluginLoader.js";
import type { McpTransport } from "./transport.js";

const DEBOUNCE_MS = 300;

export class PluginWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loadedPlugins = new Map<string, LoadedPlugin>(); // keyed by spec
  private transports = new Set<McpTransport>();
  private stopped = false;
  private reloadInFlight = new Set<string>();

  constructor(
    private config: Config,
    private logger: Logger,
    private sendListChanged: () => void,
  ) {}

  start(plugins: LoadedPlugin[]): void {
    for (const plugin of plugins) {
      this.loadedPlugins.set(plugin.spec, plugin);
      try {
        const watcher = fs.watch(
          plugin.pluginDir,
          { recursive: false },
          (_event, _filename) => {
            this.scheduleReload(plugin.spec);
          },
        );
        this.watchers.set(plugin.spec, watcher);
      } catch (err) {
        this.logger.warn(
          `[plugin-watch] Could not watch "${plugin.pluginDir}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  addTransport(transport: McpTransport): void {
    this.transports.add(transport);
  }

  removeTransport(transport: McpTransport): void {
    this.transports.delete(transport);
  }

  getTools(): LoadedPluginTool[] {
    return [...this.loadedPlugins.values()].flatMap((p) => p.tools);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.clear();
  }

  private scheduleReload(spec: string): void {
    if (this.stopped) return;
    const existing = this.debounceTimers.get(spec);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(spec);
      void this.reloadPlugin(spec);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(spec, timer);
  }

  async reloadPlugin(spec: string): Promise<void> {
    if (this.reloadInFlight.has(spec)) {
      // Another reload is already running; schedule one more after it finishes
      this.scheduleReload(spec);
      return;
    }
    this.reloadInFlight.add(spec);
    try {
      await this._reloadPluginInner(spec);
    } finally {
      this.reloadInFlight.delete(spec);
    }
  }

  private async _reloadPluginInner(spec: string): Promise<void> {
    const old = this.loadedPlugins.get(spec);
    if (!old) return;

    this.logger.info(
      `[plugin-watch] Reloading plugin "${old.manifest.name}" ...`,
    );

    // Collision names = all names from OTHER plugins
    const otherNames = new Set<string>();
    for (const [s, p] of this.loadedPlugins) {
      if (s !== spec) {
        for (const t of p.tools) otherNames.add(t.schema.name);
      }
    }

    let fresh: LoadedPlugin | null;
    try {
      fresh = await loadOnePluginFull(
        spec,
        this.config,
        this.logger,
        otherNames,
      );
    } catch (err) {
      this.logger.warn(
        `[plugin-watch] Reload threw for "${old.manifest.name}": ${err instanceof Error ? err.message : String(err)}; keeping old tools`,
      );
      return;
    }

    if (!fresh) {
      this.logger.warn(
        `[plugin-watch] Reload failed for "${old.manifest.name}"; keeping old tools`,
      );
      return;
    }

    // Apply to all active transports
    for (const transport of this.transports) {
      try {
        transport.deregisterToolsByPrefix(old.manifest.toolNamePrefix);
        for (const t of fresh.tools) {
          transport.replaceTool(t.schema, t.handler, t.timeoutMs);
        }
      } catch (err) {
        this.logger.warn(
          `[plugin-watch] Failed to patch transport for "${fresh.manifest.name}": ${err instanceof Error ? err.message : String(err)}; attempting rollback`,
        );
        // Rollback: remove any partially-registered tools and restore old ones.
        // Uses old prefix — if the plugin renamed its prefix between reloads the
        // orphaned fresh-prefix tools will remain until the next successful reload.
        // Prefix renames are uncommon and self-heal on the next save.
        try {
          transport.deregisterToolsByPrefix(old.manifest.toolNamePrefix);
          for (const t of old.tools) {
            transport.replaceTool(t.schema, t.handler, t.timeoutMs);
          }
        } catch {
          this.logger.warn(
            `[plugin-watch] Rollback also failed for "${old.manifest.name}"`,
          );
        }
      }
    }

    this.loadedPlugins.set(spec, fresh);
    const names = fresh.tools.map((t) => t.schema.name).join(", ");
    this.logger.info(
      `[plugin-watch] Plugin "${fresh.manifest.name}" reloaded — ${fresh.tools.length} tool(s)${names ? `: ${names}` : ""}`,
    );

    this.sendListChanged();
  }
}
