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
  const diagnostics = new Map<string, readonly Diagnostic[]>();
  for (const [k, v] of client.latestDiagnostics) diagnostics.set(k, [...v]);
  const aiComments = new Map<string, readonly AIComment[]>();
  for (const [k, v] of client.latestAIComments) aiComments.set(k, [...v]);
  return {
    diagnostics,
    selection: client.latestSelection,
    activeFile: client.latestActiveFile,
    aiComments,
    debugState: client.latestDebugState,
    capturedAt: Date.now(),
  };
}
