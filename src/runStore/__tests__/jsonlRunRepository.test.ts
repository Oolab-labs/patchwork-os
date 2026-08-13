/**
 * Pins the ADR-0022 contract against the INCUMBENT store.
 *
 * This runs first and must stay green on its own merits: it is the baseline
 * that gives the suite authority. A contract only validated against the new
 * implementation would be a description of that implementation, and would
 * accept whatever it happened to do.
 */

import { RecipeRunLog } from "../../runLog.js";
import { JsonlRunRepository } from "../jsonlRunRepository.js";
import { describeRunRepositoryContract } from "./runRepositoryConformance.js";

describeRunRepositoryContract("JSONL (incumbent)", (dir) => ({
  repo: JsonlRunRepository.open({ dir }),
  // A second RecipeRunLog over the same directory — the in-process stand-in
  // for a second bridge instance, which is the configuration all three known
  // defects (#1324 / #1340 / #1341) actually occurred in.
  reopen: () => new JsonlRunRepository(new RecipeRunLog({ dir })),
}));
