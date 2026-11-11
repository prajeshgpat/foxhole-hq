/** Tools that change files; repeating or alternating them is making changes, not spinning. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools that run a command, where the same call can legitimately be repeated while it passes. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash"]);
