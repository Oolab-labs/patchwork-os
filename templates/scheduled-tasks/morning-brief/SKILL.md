## Installation

Copy this template to your Claude Desktop scheduled-tasks directory:

```bash
mkdir -p ~/.claude/scheduled-tasks/morning-brief
cp /path/to/patchwork-os/templates/scheduled-tasks/morning-brief/SKILL.md \
   ~/.claude/scheduled-tasks/morning-brief/SKILL.md
```

Then restart Claude Desktop. Configure the schedule (recommended: weekdays 8am) in Claude Desktop settings under "Scheduled Tasks".

> Patchwork OS must be installed: `npm install -g patchwork-os`
> Gmail must be connected via the dashboard Connections page before this fires.

---
---
name: morning-brief
description: Run the Patchwork OS morning-brief recipe — fetches unread Gmail, recent git commits, and writes a brief to the Inbox.
schedule: "0 8 * * 1-5"
---

# Morning Brief

Run the morning-brief recipe and deliver results to the Patchwork OS Inbox.

## Steps

1. Run `Bash` with command: `patchwork-os recipe run morning-brief`
2. Confirm the output file was written to `~/.patchwork/inbox/`
3. Report the file path and a one-line summary of what was written

## Guidelines

- If Gmail returns 0 emails, still write the brief with the git activity section
- If the recipe fails, report the error clearly — do not retry automatically
- Keep the confirmation message under 3 lines
