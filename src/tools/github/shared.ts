export const GH_NOT_FOUND =
  "GitHub CLI (gh) not found. Install it from https://cli.github.com/ and run 'gh auth login'.";

export const GH_NOT_AUTHED =
  "Not authenticated with GitHub. Run 'gh auth login' first.";

export function isNotFound(msg: string): boolean {
  return msg.includes("ENOENT") || msg.includes("executable file not found");
}

export function isNotAuthed(msg: string): boolean {
  return (
    msg.includes("not authenticated") ||
    msg.includes("auth login") ||
    msg.includes("GITHUB_TOKEN") ||
    msg.includes("HTTP 401")
  );
}
