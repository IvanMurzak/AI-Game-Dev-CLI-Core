/**
 * @baizor/gamedev-cli-core — shared CLI core for the AI Game Dev engine CLIs.
 *
 * The real cli-core modules (project identity/pin v1+v2 with golden vectors,
 * OAuth 2.1 device-grant login + refresh, the machine credential store, and the
 * setup-mcp / install-plugin logic the Unity/Unreal/Godot CLIs consume as thin
 * adapters) land here through the `auth-fixes` design tasks b2/b3. This module
 * currently exposes the package version plus a small semver utility slice.
 */

/** The package version, mirrored from package.json (bumped by release.yml). */
export const version = "0.0.0";

export { parseSemver, isValidSemver } from "./semver.js";
export type { SemVer } from "./semver.js";
