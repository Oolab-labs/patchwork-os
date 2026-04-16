import type {
  AIComment,
  DebugState,
  Diagnostic,
  ExtensionClient,
  SelectionState,
} from "../extensionClient.js";

export interface ExtensionSnapshot {
  readonly diagnostics: ReadonlyMap<string, readonly Diagnostic[]>;
  readonly selection: Readonly<SelectionState> | null;
  readonly activeFile: string | null;
  readonly aiComments: ReadonlyMap<string, readonly AIComment[]>;
  readonly debugState: Readonly<DebugState> | null;
  readonly capturedAt: number;
}

// CRITICAL: Must deep-copy Maps — ReadonlyMap<K,V> is compile-time only.
// A notification arriving after snapshot creation would mutate the
// underlying Map if we just alias it.
export function snapshotExtension(client: ExtensionClient): ExtensionSnapshot {
  return {
    diagnostics: new Map(
      [...client.latestDiagnostics.entries()].map(([k, v]) => [k, [...v]]),
    ),
    selection: client.latestSelection,
    activeFile: client.latestActiveFile,
    aiComments: new Map(
      [...client.latestAIComments.entries()].map(([k, v]) => [k, [...v]]),
    ),
    debugState: client.latestDebugState,
    capturedAt: Date.now(),
  };
}
