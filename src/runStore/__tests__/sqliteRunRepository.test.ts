/**
 * The SQLite store against the SAME contract as the incumbent.
 *
 * The contract was pinned against JSONL first (#1366) precisely so this file
 * cannot quietly define its own success criteria. `reopen()` builds a second
 * independent instance over the same database file — the in-process stand-in
 * for a second bridge, which is the configuration all three known defects
 * (#1324 / #1340 / #1341) actually occurred in.
 *
 * Every instance is tracked and closed in `cleanup`. Leaving one open makes
 * `rmSync` throw `EBUSY` on Windows (an open file cannot be unlinked) while
 * POSIX deletes it happily — so the leak is invisible on macOS and ubuntu and
 * fails 57 tests on windows-latest. That is exactly how it was found.
 */

import { SqliteRunRepository } from "../sqliteRunRepository.js";
import { describeRunRepositoryContract } from "./runRepositoryConformance.js";

describeRunRepositoryContract("SQLite", (dir) => {
  const opened: SqliteRunRepository[] = [];
  const open = () => {
    const r = new SqliteRunRepository({ dir });
    opened.push(r);
    return r;
  };
  return {
    repo: open(),
    reopen: open,
    cleanup: () => {
      for (const r of opened) r.close();
      opened.length = 0;
    },
  };
});
