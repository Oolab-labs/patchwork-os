export interface LockFileData {
  port: number;
  authToken: string;
  pid: number;
  workspace?: string;
}

export type RequestHandler = (
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface AICommentEntry {
  file: string;
  line: number;
  comment: string;
  syntax: string;
  fullLine: string;
  severity: string;
}

export interface TerminalBuffer {
  name: string;
  lines: string[];
  partialLine: string;
  writeIndex: number;
  totalWritten: number;
}
