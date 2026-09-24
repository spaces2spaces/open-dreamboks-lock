/**
 * Status-discipline guard (P3, post-21/7).
 *
 * The legacy ad-hoc status "deleted" made pins invisible to every repair
 * mechanism (getRepairablePins/drift/audit only see active|used) — guests
 * whose pins got that status were permanently locked out with no self-heal.
 *
 * This test greps the server source and fails if anyone WRITES the "deleted"
 * status again. Reading it is allowed (the one-shot recovery flow must find
 * historical rows).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SERVER_DIR = join(__dirname, "..", "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("pin status discipline", () => {
  it("no server code writes the forbidden ad-hoc status \"deleted\"", () => {
    const offenders: string[] = [];
    // Writer patterns: a status assignment inside an object literal, e.g.
    //   updatePin(id, { status: "deleted" })  /  createPin({ ..., status: "deleted" })
    const writerPattern = /status:\s*["']deleted["']/;

    for (const file of collectTsFiles(SERVER_DIR)) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (writerPattern.test(line)) {
          offenders.push(`${file.replace(SERVER_DIR, "server")}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders, `Found writers of the forbidden "deleted" pin status:\n${offenders.join("\n")}`).toEqual([]);
  });
});
