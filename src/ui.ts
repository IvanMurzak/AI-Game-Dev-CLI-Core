/**
 * Dependency-free presentation helpers shared by the three engine CLIs. cli-core carries no runtime
 * dependencies (no `chalk`), so these return plain strings — the consuming CLI colours/prints them.
 * The box-drawing table mirrors the `listAgentTable` output the CLIs render for `setup-mcp --list`.
 */

/** A rendered, box-drawn table as a single multi-line string (no ANSI colour). */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const columns = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 0),
  );

  const bar = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;

  const line = (cells: readonly string[]): string =>
    "│" + widths.map((w, i) => ` ${(cells[i] ?? "").padEnd(w)} `).join("│") + "│";

  const out: string[] = [];
  out.push(bar("┌", "┬", "┐"));
  out.push(line(headers));
  out.push(bar("├", "┼", "┤"));
  for (const row of rows) out.push(line(row));
  out.push(bar("└", "┴", "┘"));
  return out.join("\n");
}

/**
 * Truncate a string to `max` characters with a trailing ellipsis (never longer than `max`). Used to
 * keep long config paths inside a table column.
 */
export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return value.slice(0, max - 1) + "…";
}
