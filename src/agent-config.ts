/**
 * AI-agent MCP config writers — the TypeScript port of the shared C# reference
 * `com.IvanMurzak.McpPlugin.AgentConfig.JsonAiAgentConfig` / `TomlAiAgentConfig`
 * (`MCP-Plugin-dotnet/McpPlugin/src/AgentConfig/*.cs`), the single source of truth every
 * configurator (editor UI, the three engine CLIs, `configure`) writes through. An agent's MCP
 * client config file is JSON (Claude/Cursor/VS Code/…) or TOML (Codex); this module reproduces the
 * C# writers' behaviour byte-for-byte so a CLI-written config and an editor-written config are
 * indistinguishable.
 *
 * **Byte-for-byte parity is gated by golden vectors** (`test/golden-vectors/AgentConfig.*.json`),
 * exactly as the identity module is gated by `ProjectIdentity.GoldenVectors.json`. The vectors pin
 * the deterministic new-file serialization ({@link JsonAiAgentConfig.expectedFileContent} /
 * {@link TomlAiAgentConfig.expectedFileContent}) for a canonical property matrix.
 *
 * Two behaviours make the writers safe to run against a user's existing config:
 *   - **deterministic property ordering** — server-entry keys are emitted in `Ordinal` sort order
 *     (matches C# `OrderBy(k => k, StringComparer.Ordinal)`), so a re-run never reorders keys;
 *   - **duplicate/deprecated cleanup** — a sibling entry written under a different name but the same
 *     identity value (`command` / `url` by default) is removed, and legacy server names
 *     (`Unity-MCP`) are cleaned up, so re-configuring never leaves a stale duplicate server.
 *
 * The `serverName` and `deprecatedServerNames` are constructor parameters (the C# reference hard-codes
 * `ai-game-developer` / `Unity-MCP`) so an engine adapter selects them — Unreal writes `unreal-mcp`,
 * Unity/Godot write `ai-game-developer` — keeping engine specifics in the adapter, never here.
 *
 * NOTE on JSON escaping: System.Text.Json escapes `<`, `>`, `&`, `+`, `'` and all non-ASCII as
 * `\uXXXX`; `JSON.stringify` does not. For the ASCII, HTML-safe data these writers emit (forward-slash
 * paths, `scheme://host/path` URLs, `key=value` args, base64url tokens) the two serializers are
 * byte-identical — the domain that matters. The golden vectors stay inside that domain.
 */

import * as fs from "node:fs";

// ── shared model ──────────────────────────────────────────────────────────────────────────────

/** How a configured value is compared against the value on disk when deciding "already configured". */
export enum ValueComparisonMode {
  /** Byte-for-byte string equality. */
  Exact = "Exact",
  /** Filesystem-path equality (separator-insensitive, trailing-slash-insensitive). */
  Path = "Path",
  /** URL equality (scheme/host case-insensitive, trailing-slash-insensitive). */
  Url = "Url",
}

/** The canonical server-entry name written under the body path (C# `DefaultMcpServerName`). */
export const DEFAULT_MCP_SERVER_NAME = "ai-game-developer";

/** Server-entry names written by older plugin versions, cleaned up on configure/unconfigure. */
export const DEFAULT_DEPRECATED_MCP_SERVER_NAMES: readonly string[] = ["Unity-MCP"];

/** Property keys used to recognise the same server entry written under a different name. */
export const DEFAULT_IDENTITY_KEYS: readonly string[] = ["command", "url"];

/** The nested-body-path delimiter (C# `Consts.MCP.Server.BodyPathDelimiter`). */
export const BODY_PATH_DELIMITER = "->";

/** The default body path (C# `Consts.MCP.Server.DefaultBodyPath`). */
export const DEFAULT_BODY_PATH = "mcpServers";

/** Split a body path into its object-nesting segments (C# `BodyPathSegments`). */
export function bodyPathSegments(bodyPath: string): string[] {
  return bodyPath.split(BODY_PATH_DELIMITER);
}

/** Options shared by both config writers. */
export interface AgentConfigOptions {
  /** The canonical server-entry name; defaults to {@link DEFAULT_MCP_SERVER_NAME}. */
  serverName?: string;
  /** Body path (dot-free; `->`-delimited for nesting); defaults to {@link DEFAULT_BODY_PATH}. */
  bodyPath?: string;
  /** Deprecated server names to clean up; defaults to {@link DEFAULT_DEPRECATED_MCP_SERVER_NAMES}. */
  deprecatedServerNames?: readonly string[];
}

interface PropertyRecord<V> {
  value: V;
  required: boolean;
  comparison: ValueComparisonMode;
}

// ── shared normalization (identical rules in JSON and TOML writers) ─────────────────────────────

/** Normalize a file path by unifying separators and trimming a trailing slash (C# `NormalizePath`). */
function normalizePathValue(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Normalize a URL: lowercase scheme+authority, trim a trailing path slash, keep the query (C# `NormalizeUrl`). */
function normalizeUrlValue(value: string): string {
  try {
    const uri = new URL(value);
    const authority = `${uri.protocol}//${uri.host}`.toLowerCase();
    const pathPart = uri.pathname.replace(/\/+$/, "");
    return authority + pathPart + uri.search;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function areStringValuesEquivalent(comparison: ValueComparisonMode, expected: string, actual: string): boolean {
  if (comparison === ValueComparisonMode.Path) {
    return normalizePathValue(expected) === normalizePathValue(actual);
  }
  if (comparison === ValueComparisonMode.Url) {
    return normalizeUrlValue(expected).toLowerCase() === normalizeUrlValue(actual).toLowerCase();
  }
  return expected === actual;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// JSON writer
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A JSON-representable value stored on the server entry (object / array / primitive / null). */
export type JsonNode =
  | string
  | number
  | boolean
  | null
  | JsonNode[]
  | { [key: string]: JsonNode };

/**
 * The JSON MCP-config writer (Claude Code/Desktop, Cursor, VS Code, Gemini, …). Port of C#
 * `JsonAiAgentConfig`. Build up the desired server entry with {@link setProperty} /
 * {@link setPropertyToRemove}, then {@link configure} a config file on disk. `fs` is injected so the
 * writer is testable with no real filesystem.
 */
export class JsonAiAgentConfig {
  readonly serverName: string;
  readonly bodyPath: string;
  readonly deprecatedServerNames: readonly string[];
  private readonly _properties = new Map<string, PropertyRecord<JsonNode>>();
  private readonly _propertiesToRemove = new Set<string>();
  private readonly _identityKeys: string[] = [...DEFAULT_IDENTITY_KEYS];

  constructor(options: AgentConfigOptions = {}) {
    this.serverName = options.serverName ?? DEFAULT_MCP_SERVER_NAME;
    this.bodyPath = options.bodyPath ?? DEFAULT_BODY_PATH;
    this.deprecatedServerNames = options.deprecatedServerNames ?? DEFAULT_DEPRECATED_MCP_SERVER_NAMES;
  }

  get identityKeys(): readonly string[] {
    return this._identityKeys;
  }

  setProperty(
    key: string,
    value: JsonNode,
    requiredForConfiguration = false,
    comparison: ValueComparisonMode = ValueComparisonMode.Exact,
  ): this {
    this._properties.set(key, { value, required: requiredForConfiguration, comparison });
    return this;
  }

  setPropertyToRemove(key: string): this {
    this._propertiesToRemove.add(key);
    return this;
  }

  addIdentityKey(key: string): this {
    if (!this._identityKeys.includes(key)) this._identityKeys.push(key);
    return this;
  }

  /** Apply the HTTP `Authorization: Bearer <token>` header, or remove `headers` when not required. */
  applyHttpAuthorization(isRequired: boolean, token: string | undefined): this {
    if (isRequired && token) {
      this.setProperty("headers", { Authorization: `Bearer ${token}` }, true);
    } else {
      this.setPropertyToRemove("headers");
    }
    return this;
  }

  /** Add or remove the stdio `token=<token>` arg (never touches HTTP `headers`, which it strips). */
  applyStdioAuthorization(isRequired: boolean, token: string | undefined): this {
    this.setPropertyToRemove("headers");
    const argsProp = this._properties.get("args");
    if (!argsProp || !Array.isArray(argsProp.value)) return this;

    const tokenPrefix = "token=";
    const newArgs: JsonNode[] = argsProp.value.filter(
      (item) => !(typeof item === "string" && item.startsWith(tokenPrefix)),
    );
    if (isRequired && token) newArgs.push(`${tokenPrefix}${token}`);
    this.setProperty("args", newArgs, argsProp.required, argsProp.comparison);
    return this;
  }

  /** The deterministic new-file content: the server entry nested under the body path, 2-space indent. */
  expectedFileContent(): string {
    const segments = bodyPathSegments(this.bodyPath);
    let node: JsonNode = { [this.serverName]: this.buildServerEntry() };
    for (let i = segments.length - 1; i >= 0; i--) {
      node = { [segments[i]!]: node };
    }
    return JSON.stringify(node, null, 2);
  }

  /**
   * Configure `configPath`: create it from {@link expectedFileContent} when absent (or unparsable),
   * else merge the server entry in — removing deprecated + duplicate sibling entries, dropping the
   * `propertiesToRemove` keys, and writing properties in Ordinal order. Returns true on success.
   */
  configure(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath) return false;
    try {
      if (!io.existsSync(configPath)) {
        io.mkdirSync(dirname(configPath));
        io.writeFileSync(configPath, this.expectedFileContent());
        return true;
      }

      let root: Record<string, JsonNode>;
      try {
        const parsed = JSON.parse(io.readFileSync(configPath));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        root = parsed as Record<string, JsonNode>;
      } catch {
        io.writeFileSync(configPath, this.expectedFileContent());
        return true;
      }

      const target = ensureJsonPath(root, bodyPathSegments(this.bodyPath));

      for (const name of this.deprecatedServerNames) delete target[name];
      for (const key of this.findDuplicateServerEntryKeys(target)) delete target[key];

      let entry = target[this.serverName];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        entry = {};
        target[this.serverName] = entry;
      }
      const serverEntry = entry as Record<string, JsonNode>;

      for (const key of this._propertiesToRemove) delete serverEntry[key];
      for (const key of this.sortedPropertyKeys()) {
        serverEntry[key] = cloneJson(this._properties.get(key)!.value);
      }

      io.writeFileSync(configPath, JSON.stringify(root, null, 2));
      return this.isConfigured(configPath, io);
    } catch {
      return false;
    }
  }

  /** Remove our (and deprecated/duplicate) server entries. Returns true when something was removed. */
  unconfigure(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath || !io.existsSync(configPath)) return false;
    try {
      const parsed = JSON.parse(io.readFileSync(configPath));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const root = parsed as Record<string, JsonNode>;
      const target = navigateJsonPath(root, bodyPathSegments(this.bodyPath));
      if (!target) return false;

      let removed = false;
      if (target[this.serverName] != null) {
        delete target[this.serverName];
        removed = true;
      }
      for (const name of this.deprecatedServerNames) {
        if (target[name] != null) {
          delete target[name];
          removed = true;
        }
      }
      const dupes = this.findDuplicateServerEntryKeys(target);
      if (dupes.length > 0) {
        for (const key of dupes) delete target[key];
        removed = true;
      }
      if (!removed) return false;

      io.writeFileSync(configPath, JSON.stringify(root, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /** True when our server entry, a deprecated entry, or a duplicate sibling is present. */
  isDetected(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath || !io.existsSync(configPath)) return false;
    try {
      const text = io.readFileSync(configPath);
      if (!text.trim()) return false;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const target = navigateJsonPath(parsed as Record<string, JsonNode>, bodyPathSegments(this.bodyPath));
      if (!target) return false;
      if (target[this.serverName] != null) return true;
      for (const name of this.deprecatedServerNames) if (target[name] != null) return true;
      return this.findDuplicateServerEntryKeys(target).length > 0;
    } catch {
      return false;
    }
  }

  /** True when every required property matches on disk and no property-to-remove is present. */
  isConfigured(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath || !io.existsSync(configPath)) return false;
    try {
      const text = io.readFileSync(configPath);
      if (!text.trim()) return false;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const target = navigateJsonPath(parsed as Record<string, JsonNode>, bodyPathSegments(this.bodyPath));
      if (!target) return false;
      const serverEntry = target[this.serverName];
      if (serverEntry == null || typeof serverEntry !== "object" || Array.isArray(serverEntry)) return false;
      return this.requiredPropertiesMatch(serverEntry) && !this.hasPropertiesToRemove(serverEntry);
    } catch {
      return false;
    }
  }

  private buildServerEntry(): Record<string, JsonNode> {
    const obj: Record<string, JsonNode> = {};
    for (const key of this.sortedPropertyKeys()) {
      obj[key] = cloneJson(this._properties.get(key)!.value);
    }
    return obj;
  }

  private sortedPropertyKeys(): string[] {
    return [...this._properties.keys()].sort(ordinalCompare);
  }

  private requiredPropertiesMatch(entry: Record<string, JsonNode>): boolean {
    for (const [key, prop] of this._properties) {
      if (!prop.required) continue;
      const existing = entry[key];
      if (existing == null) return false;
      if (!jsonValuesEquivalent(prop.comparison, prop.value, existing)) return false;
    }
    return true;
  }

  private hasPropertiesToRemove(entry: Record<string, JsonNode>): boolean {
    for (const key of this._propertiesToRemove) if (entry[key] != null) return true;
    return false;
  }

  private findDuplicateServerEntryKeys(target: Record<string, JsonNode>): string[] {
    const ours: Array<[string, JsonNode, ValueComparisonMode]> = [];
    for (const identityKey of this._identityKeys) {
      const prop = this._properties.get(identityKey);
      if (prop) ours.push([identityKey, prop.value, prop.comparison]);
    }
    if (ours.length === 0) return [];

    const keys: string[] = [];
    for (const [name, entry] of Object.entries(target)) {
      if (name === this.serverName) continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const entryObj = entry as Record<string, JsonNode>;
      for (const [key, value, comparison] of ours) {
        const existing = entryObj[key];
        if (existing != null && jsonValuesEquivalent(comparison, value, existing)) {
          keys.push(name);
          break;
        }
      }
    }
    return keys;
  }
}

function jsonValuesEquivalent(comparison: ValueComparisonMode, expected: JsonNode, actual: JsonNode): boolean {
  if (
    (comparison === ValueComparisonMode.Path || comparison === ValueComparisonMode.Url) &&
    typeof expected === "string" &&
    typeof actual === "string"
  ) {
    return areStringValuesEquivalent(comparison, expected, actual);
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function ensureJsonPath(root: Record<string, JsonNode>, segments: string[]): Record<string, JsonNode> {
  let current = root;
  for (const segment of segments) {
    const next = current[segment];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      current = next as Record<string, JsonNode>;
    } else {
      const created: Record<string, JsonNode> = {};
      current[segment] = created;
      current = created;
    }
  }
  return current;
}

function navigateJsonPath(root: Record<string, JsonNode>, segments: string[]): Record<string, JsonNode> | null {
  let current: Record<string, JsonNode> | null = root;
  for (const segment of segments) {
    if (!current) return null;
    const next: JsonNode | undefined = current[segment];
    current = next && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, JsonNode>) : null;
  }
  return current;
}

function cloneJson(value: JsonNode): JsonNode {
  return value === null || typeof value !== "object" ? value : (JSON.parse(JSON.stringify(value)) as JsonNode);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// TOML writer
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A raw TOML value written back verbatim (floats/dates the minimal parser does not model). */
export class RawTomlValue {
  constructor(public readonly value: string) {}
}

/** A value storable in a TOML server section (C# `TomlAiAgentConfig` value union). */
export type TomlValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[]
  | Record<string, string>
  | RawTomlValue;

/**
 * The TOML MCP-config writer (Codex). Port of C# `TomlAiAgentConfig`. TOML sections are
 * `[<bodyPath>.<serverName>]`; the writer merges into an existing section, preserving unrelated
 * sections/keys and typed values it does not manage (floats/dates via {@link RawTomlValue}). All
 * output uses `\n` line endings (the C# reference uses `Environment.NewLine`; the golden vectors are
 * the LF form, which is what the CLI and Linux CI emit).
 */
export class TomlAiAgentConfig {
  readonly serverName: string;
  readonly bodyPath: string;
  readonly deprecatedServerNames: readonly string[];
  private readonly _properties = new Map<string, PropertyRecord<TomlValue>>();
  private readonly _propertiesToRemove = new Set<string>();
  private readonly _identityKeys: string[] = [...DEFAULT_IDENTITY_KEYS];

  constructor(options: AgentConfigOptions = {}) {
    this.serverName = options.serverName ?? DEFAULT_MCP_SERVER_NAME;
    this.bodyPath = options.bodyPath ?? "mcp_servers";
    this.deprecatedServerNames = options.deprecatedServerNames ?? DEFAULT_DEPRECATED_MCP_SERVER_NAMES;
  }

  get identityKeys(): readonly string[] {
    return this._identityKeys;
  }

  get sectionName(): string {
    return `${this.bodyPath}.${this.serverName}`;
  }

  setProperty(
    key: string,
    value: TomlValue,
    requiredForConfiguration = false,
    comparison: ValueComparisonMode = ValueComparisonMode.Exact,
  ): this {
    this._properties.set(key, { value, required: requiredForConfiguration, comparison });
    return this;
  }

  setPropertyToRemove(key: string): this {
    this._propertiesToRemove.add(key);
    return this;
  }

  addIdentityKey(key: string): this {
    if (!this._identityKeys.includes(key)) this._identityKeys.push(key);
    return this;
  }

  /** TOML HTTP config does not model an auth header (matches C# — deliberate no-op). */
  applyHttpAuthorization(_isRequired: boolean, _token: string | undefined): this {
    return this;
  }

  applyStdioAuthorization(isRequired: boolean, token: string | undefined): this {
    const argsProp = this._properties.get("args");
    if (!argsProp || !isStringArray(argsProp.value)) return this;
    const tokenPrefix = "token=";
    const filtered = argsProp.value.filter((a) => !a.startsWith(tokenPrefix));
    if (isRequired && token) filtered.push(`${tokenPrefix}${token}`);
    this.setProperty("args", filtered, argsProp.required, argsProp.comparison);
    return this;
  }

  /** The deterministic new-file content: the section header + Ordinal-ordered props, trailing `\n`. */
  expectedFileContent(): string {
    let out = `[${this.sectionName}]\n`;
    for (const key of this.sortedKeys(this._properties)) {
      out += formatTomlProperty(key, this._properties.get(key)!.value) + "\n";
    }
    return out;
  }

  /** Configure `configPath`: create from {@link expectedFileContent} when absent, else merge. */
  configure(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath) return false;
    try {
      if (!io.existsSync(configPath)) {
        io.mkdirSync(dirname(configPath));
        io.writeFileSync(configPath, this.expectedFileContent());
        return true;
      }

      let lines = splitLines(io.readFileSync(configPath));

      for (const deprecated of this.deprecatedServerNames) {
        const idx = findTomlSection(lines, `${this.bodyPath}.${deprecated}`);
        if (idx >= 0) lines.splice(idx, findSectionEnd(lines, idx) - idx);
      }
      this.removeDuplicateSections(lines);

      const sectionIndex = findTomlSection(lines, this.sectionName);
      if (sectionIndex >= 0) {
        const end = findSectionEnd(lines, sectionIndex);
        const existing = parseSectionProperties(lines, sectionIndex + 1, end);
        for (const key of this._propertiesToRemove) existing.delete(key);
        for (const [key, prop] of this._properties) existing.set(key, prop.value);
        lines.splice(sectionIndex, end - sectionIndex);
        const newSection = this.generateSection(existing).replace(/\n+$/, "");
        lines.splice(sectionIndex, 0, ...splitLines(newSection));
      } else {
        if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") lines.push("");
        const props = new Map<string, TomlValue>();
        for (const [key, prop] of this._properties) props.set(key, prop.value);
        lines.push(...splitLines(this.generateSection(props).replace(/\n+$/, "")));
      }

      io.writeFileSync(configPath, lines.join("\n"));
      return this.isConfigured(configPath, io);
    } catch {
      return false;
    }
  }

  unconfigure(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath || !io.existsSync(configPath)) return false;
    try {
      const lines = splitLines(io.readFileSync(configPath));
      let changed = false;

      const idx = findTomlSection(lines, this.sectionName);
      if (idx >= 0) {
        lines.splice(idx, findSectionEnd(lines, idx) - idx);
        changed = true;
      }
      for (const deprecated of this.deprecatedServerNames) {
        const di = findTomlSection(lines, `${this.bodyPath}.${deprecated}`);
        if (di >= 0) {
          lines.splice(di, findSectionEnd(lines, di) - di);
          changed = true;
        }
      }
      const before = lines.length;
      this.removeDuplicateSections(lines);
      if (lines.length !== before) changed = true;

      if (!changed) return false;
      io.writeFileSync(configPath, lines.join("\n"));
      return true;
    } catch {
      return false;
    }
  }

  isDetected(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath || !io.existsSync(configPath)) return false;
    try {
      const lines = splitLines(io.readFileSync(configPath));
      if (findTomlSection(lines, this.sectionName) >= 0) return true;
      for (const deprecated of this.deprecatedServerNames) {
        if (findTomlSection(lines, `${this.bodyPath}.${deprecated}`) >= 0) return true;
      }
      return this.findDuplicateSectionIndices(lines).length > 0;
    } catch {
      return false;
    }
  }

  isConfigured(configPath: string, io: AgentConfigFs = nodeFs): boolean {
    if (!configPath || !io.existsSync(configPath)) return false;
    try {
      const lines = splitLines(io.readFileSync(configPath));
      const idx = findTomlSection(lines, this.sectionName);
      if (idx < 0) return false;
      const existing = parseSectionProperties(lines, idx + 1, findSectionEnd(lines, idx));
      return this.requiredPropertiesMatch(existing) && !this.hasPropertiesToRemove(existing);
    } catch {
      return false;
    }
  }

  private generateSection(properties: Map<string, TomlValue>): string {
    let out = `[${this.sectionName}]\n`;
    for (const key of this.sortedKeys(properties)) {
      out += formatTomlProperty(key, properties.get(key)!) + "\n";
    }
    return out;
  }

  private sortedKeys<V>(map: Map<string, V>): string[] {
    return [...map.keys()].sort(ordinalCompare);
  }

  private requiredPropertiesMatch(existing: Map<string, TomlValue>): boolean {
    for (const [key, prop] of this._properties) {
      if (!prop.required) continue;
      if (!existing.has(key)) return false;
      if (!tomlValuesMatch(prop.comparison, prop.value, existing.get(key)!)) return false;
    }
    return true;
  }

  private hasPropertiesToRemove(existing: Map<string, TomlValue>): boolean {
    for (const key of this._propertiesToRemove) if (existing.has(key)) return true;
    return false;
  }

  private findDuplicateSectionIndices(lines: string[]): Array<[number, number]> {
    const ours: Array<[string, string, ValueComparisonMode]> = [];
    for (const key of this._identityKeys) {
      const prop = this._properties.get(key);
      if (prop && typeof prop.value === "string") ours.push([key, prop.value, prop.comparison]);
    }
    if (ours.length === 0) return [];

    const bodyPrefix = `[${this.bodyPath}.`;
    const result: Array<[number, number]> = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (!trimmed.startsWith(bodyPrefix) || !trimmed.endsWith("]")) continue;
      const fullSectionName = trimmed.slice(1, -1);
      if (fullSectionName === this.sectionName) continue;
      const end = findSectionEnd(lines, i);
      const props = parseSectionProperties(lines, i + 1, end);
      const isDupe = ours.some(([key, value, comparison]) => {
        const existing = props.get(key);
        return typeof existing === "string" && areStringValuesEquivalent(comparison, value, existing);
      });
      if (isDupe) result.push([i, end]);
    }
    return result;
  }

  private removeDuplicateSections(lines: string[]): void {
    const sections = this.findDuplicateSectionIndices(lines);
    for (let i = sections.length - 1; i >= 0; i--) {
      const [start, end] = sections[i]!;
      lines.splice(start, end - start);
    }
  }
}

function tomlValuesMatch(comparison: ValueComparisonMode, expected: TomlValue, actual: TomlValue): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return areStringValuesEquivalent(comparison, expected, actual);
  }
  if (typeof expected === "boolean" && typeof actual === "boolean") return expected === actual;
  if (typeof expected === "number" && typeof actual === "number") return expected === actual;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return false;
    return expected.every((e, i) => {
      const a = actual[i];
      if (typeof e === "string" && typeof a === "string") return areStringValuesEquivalent(comparison, e, a);
      return e === a;
    });
  }
  return false;
}

function formatTomlProperty(key: string, value: TomlValue): string {
  if (value instanceof RawTomlValue) return `${key} = ${value.value}`;
  if (typeof value === "string") return `${key} = "${escapeTomlString(value)}"`;
  if (typeof value === "boolean") return `${key} = ${value ? "true" : "false"}`;
  if (typeof value === "number") return `${key} = ${value}`;
  if (Array.isArray(value)) {
    const items = (value as Array<string | number | boolean>).map((v) =>
      typeof v === "string" ? `"${escapeTomlString(v)}"` : typeof v === "boolean" ? (v ? "true" : "false") : `${v}`,
    );
    return `${key} = [${items.join(",")}]`;
  }
  // Record<string,string> inline table.
  const pairs = Object.entries(value).map(([k, v]) => `"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`);
  return `${key} = { ${pairs.join(", ")} }`;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isStringArray(value: TomlValue): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function findTomlSection(lines: string[], sectionName: string): number {
  const header = `[${sectionName}]`;
  return lines.findIndex((l) => l.trim() === header);
}

function findSectionEnd(lines: string[], sectionStartIndex: number): number {
  for (let i = sectionStartIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) return i;
  }
  return lines.length;
}

/** Parse a TOML section body (a subset that round-trips the C# reference's supported value types). */
function parseSectionProperties(lines: string[], startIndex: number, endIndex: number): Map<string, TomlValue> {
  const props = new Map<string, TomlValue>();
  for (let i = startIndex; i < endIndex; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();

    if (rawValue.startsWith("[")) {
      props.set(key, parseTypedArray(stripArrayInlineComment(rawValue)));
    } else if (rawValue.startsWith('"')) {
      const s = parseTomlString(rawValue);
      if (s !== null) props.set(key, s);
    } else if (rawValue.startsWith("{")) {
      const table = parseInlineTable(rawValue);
      props.set(key, table ?? new RawTomlValue(rawValue));
    } else {
      const scalar = stripInlineComment(rawValue);
      if (scalar === "true" || scalar === "false") props.set(key, scalar === "true");
      else if (/^-?\d+$/.test(scalar)) props.set(key, parseInt(scalar, 10));
      else if (scalar.length > 0) props.set(key, new RawTomlValue(scalar));
    }
  }
  return props;
}

function parseTomlString(rawValue: string): string | null {
  if (!rawValue.startsWith('"')) return rawValue;
  for (let i = 1; i < rawValue.length; i++) {
    if (rawValue[i] === "\\") {
      i++;
      continue;
    }
    if (rawValue[i] === '"') {
      return rawValue.slice(1, i).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return rawValue;
}

function parseTypedArray(rawValue: string): TomlValue {
  if (!rawValue.startsWith("[") || !rawValue.endsWith("]")) return [];
  const content = rawValue.slice(1, -1).trim();
  if (content.length === 0) return [] as string[];
  if (content.startsWith('"')) return parseStringArrayContent(content);
  if (content.startsWith("true") || content.startsWith("false")) {
    return parseBoolArrayContent(content) ?? new RawTomlValue(rawValue);
  }
  if (/[-0-9]/.test(content[0]!)) return parseIntArrayContent(content) ?? new RawTomlValue(rawValue);
  return parseStringArrayContent(content);
}

function parseStringArrayContent(content: string): string[] {
  const result: string[] = [];
  let inQuote = false;
  let escaped = false;
  let current = "";
  for (const ch of content) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (inQuote) {
        result.push(current.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        current = "";
      }
      inQuote = !inQuote;
    } else if (inQuote) {
      current += ch;
    }
  }
  return result;
}

function parseBoolArrayContent(content: string): boolean[] | null {
  const out: boolean[] = [];
  for (const raw of content.split(",")) {
    const t = raw.trim().toLowerCase();
    if (t === "true") out.push(true);
    else if (t === "false") out.push(false);
    else return null;
  }
  return out;
}

function parseIntArrayContent(content: string): number[] | null {
  const out: number[] = [];
  for (const raw of content.split(",")) {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) return null;
    out.push(parseInt(t, 10));
  }
  return out;
}

function parseInlineTable(rawValue: string): Record<string, string> | null {
  const trimmed = rawValue.trim();
  const close = trimmed.lastIndexOf("}");
  if (!trimmed.startsWith("{") || close < 0) return null;
  const content = trimmed.slice(1, close).trim();
  const result: Record<string, string> = {};
  if (content.length === 0) return result;

  let pos = 0;
  const readQuoted = (): string | null => {
    if (content[pos] !== '"') return null;
    pos++;
    let sb = "";
    while (pos < content.length) {
      const c = content[pos]!;
      if (c === "\\" && pos + 1 < content.length) {
        pos++;
        sb += content[pos];
        pos++;
        continue;
      }
      if (c === '"') {
        pos++;
        return sb;
      }
      sb += c;
      pos++;
    }
    return null;
  };
  while (pos < content.length) {
    while (pos < content.length && (/\s/.test(content[pos]!) || content[pos] === ",")) pos++;
    if (pos >= content.length) break;
    let key: string | null;
    if (content[pos] === '"') key = readQuoted();
    else {
      const start = pos;
      while (pos < content.length && content[pos] !== "=" && content[pos] !== ",") pos++;
      key = content.slice(start, pos).trim();
    }
    if (key === null) return null;
    while (pos < content.length && /\s/.test(content[pos]!)) pos++;
    if (content[pos] !== "=") return null;
    pos++;
    while (pos < content.length && /\s/.test(content[pos]!)) pos++;
    let value: string | null;
    if (content[pos] === '"') value = readQuoted();
    else {
      const start = pos;
      while (pos < content.length && content[pos] !== ",") pos++;
      value = content.slice(start, pos).trim();
    }
    if (value === null) return null;
    result[key] = value;
  }
  return result;
}

function stripInlineComment(value: string): string {
  const idx = value.indexOf("#");
  return idx >= 0 ? value.slice(0, idx).trimEnd() : value;
}

function stripArrayInlineComment(value: string): string {
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuote) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return value.slice(0, i + 1);
    }
  }
  return value;
}

// ── shared helpers ──────────────────────────────────────────────────────────────────────────────

function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Split on `\n`, tolerating CRLF (C# `File.ReadAllLines` behaviour). */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function dirname(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? norm.slice(0, idx + 1) || "." : norm.slice(0, idx);
}

/**
 * Minimal filesystem seam used by the config writers, so they are unit-testable without touching
 * disk. The default is a thin `node:fs` wrapper ({@link nodeFs}).
 */
export interface AgentConfigFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(dir: string): void;
}

export const nodeFs: AgentConfigFs = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, "utf-8"),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  mkdirSync: (dir) => {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  },
};
