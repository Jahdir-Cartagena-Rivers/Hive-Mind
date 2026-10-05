// @effect-diagnostics nodeBuiltinImport:off - environment-owned persistence boundary.
// @effect-diagnostics globalDate:off - timestamps at the async file-store boundary match the legacy format.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { type HiveMindConfig, type HiveMindMutation, type HiveMindSnapshot } from "./contracts.ts";
import { hivePaths, readHiveConfig, validateHiveConfig } from "./config.ts";
import { writeAtomic } from "./files.ts";
import {
  forgetHiveMind,
  hiveMindStatus,
  notifyHiveMindChange,
  onHiveMindChange,
  rememberHiveMind,
  syncHiveMind,
} from "./engine.ts";
import { editHiveFact } from "./store.ts";

/** The environment owns one worker. Saves stay local; projection receipts survive restarts. */
export class HiveMindRuntime {
  readonly file: string;
  private running: Promise<void> | undefined;
  private requested = false;
  private closed = false;
  private phase: HiveMindSnapshot["phase"] = "idle";
  private issues: string[] = [];
  private lastSync: string | null = null;
  private unsubscribe: () => void;
  private readonly beforeSync: (() => Promise<void>) | undefined;
  constructor(file: string, beforeSync?: () => Promise<void>) {
    this.file = file;
    this.beforeSync = beforeSync;
    this.unsubscribe = onHiveMindChange(file, () => {
      void this.automatic();
    });
  }
  async snapshot(): Promise<HiveMindSnapshot> {
    const config = await readHiveConfig(this.file);
    const status = await hiveMindStatus(this.file);
    return {
      config,
      defaultVault: NodePath.join(NodePath.dirname(this.file), "Hive Mind Vault"),
      defaultBank: `j1-hive-${NodeCrypto.createHash("sha256").update(NodePath.resolve(this.file)).digest("hex").slice(0, 12)}`,
      records: status.records,
      skills: status.skills,
      pendingIndex: status.pendingIndex,
      phase: config.automatic === false && !this.running ? "paused" : this.phase,
      lastSync: this.lastSync,
      issues: this.issues,
    };
  }
  async configure(value: HiveMindConfig) {
    const config = validateHiveConfig(value);
    await writeAtomic(hivePaths(this.file).config, JSON.stringify(config, null, 2));
    await this.automatic();
    return this.snapshot();
  }
  async mutate(input: HiveMindMutation) {
    switch (input.action) {
      case "remember":
        await rememberHiveMind(this.file, {
          ...input,
          project: input.project ?? null,
          sourceThreadId: "hive-mind-ui",
        });
        break;
      case "forget":
        await forgetHiveMind(this.file, input.id);
        break;
      case "edit":
        await editHiveFact(
          this.file,
          input.id,
          input.revision,
          input.fact,
          `hive-mind-ui:${input.id}`,
        );
        notifyHiveMindChange(this.file);
        break;
    }
    return this.snapshot();
  }
  async automatic() {
    try {
      const config = await readHiveConfig(this.file);
      if (
        !this.closed &&
        config.automatic !== false &&
        (config.vault || config.hindsight || config.skills?.length)
      )
        this.requestSync();
    } catch (error) {
      this.phase = "degraded";
      this.issues = [String(error)];
    }
  }
  requestSync() {
    if (this.closed) return;
    this.requested = true;
    if (this.running) return;
    this.phase = "syncing";
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
  }
  private async drain() {
    try {
      while (this.requested && !this.closed) {
        this.requested = false;
        const recoveryIssues: string[] = [];
        try {
          await this.beforeSync?.();
        } catch (error) {
          recoveryIssues.push(`Engine recovery: ${String(error)}`);
        }
        const report = await syncHiveMind(this.file, 10);
        this.issues = [...recoveryIssues, ...report.issues];
        this.lastSync = new Date().toISOString();
        this.phase = this.issues.length ? "degraded" : "idle";
        if (report.status.pendingIndex > 0 && this.issues.length === 0) {
          this.requested = true;
          this.phase = "syncing";
        }
      }
    } catch (error) {
      this.phase = "degraded";
      this.issues = [String(error)];
    }
  }
  async waitIdle() {
    await this.automatic();
    await this.running;
  }
  async close() {
    this.closed = true;
    this.unsubscribe();
    await this.waitIdle();
  }
}
