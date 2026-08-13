/**
 * The SQLite store against the SAME contract as the incumbent.
 *
 * The contract was pinned against JSONL first (#1366) precisely so this file
 * cannot quietly define its own success criteria. `reopen()` builds a second
 * independent instance over the same database file — the in-process stand-in
 * for a second bridge, which is the configuration all three known defects
 * (#1324 / #1340 / #1341) actually occurred in.
 */

import { SqliteRunRepository } from "../sqliteRunRepository.js";
import { describeRunRepositoryContract } from "./runRepositoryConformance.js";

describeRunRepositoryContract("SQLite", (dir) => ({
  repo: new SqliteRunRepository({ dir }),
  reopen: () => new SqliteRunRepository({ dir }),
}));
