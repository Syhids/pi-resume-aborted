# pi-resume-aborted

A [pi](https://pi.dev) extension that makes it easy to pick up after cancelling with `Escape`.

When you cancel, pi aborts the running tool (or the model's response) and there is no way to "resume" it. The usual workaround is typing something like `.` so the model carries on, but then the model has to guess whether you wanted to retry, skip that step, or change approach. This extension removes that ambiguity.

## What it does

After cancelling, a notice appears above the editor:

```
⏸ Cancelled: bash · npm run build
  "." retry  ·  alt+c skip  ·  alt+x correct
```

| Action | How | What the model receives |
|---|---|---|
| Retry | `.` or `/retry` | "I cancelled this tool call, but not because of the approach: run it again with the same arguments and continue" |
| Skip | `alt+c` or `/skip` | "I intentionally cancelled it: do not repeat it and continue with the task" |
| Correct | `alt+x` or `/fix` | Prefills the editor with `` Do not repeat `…`. Instead, `` so you can finish the sentence |

- If you interrupt the model **while it is writing or thinking** (no tool running), the notice says *Response interrupted* and `.` asks it to continue where it left off.
- For `write`, `edit`, or `bash` commands with side effects (`rm`, `git push`, `>`, `npm install`, migrations…) it warns that **partial state may have been left behind**, and the model checks before retrying.
- Typing anything else dismisses the notice and your message is sent unchanged.
- The extension **never re-runs the tool itself**: it sends the model an explicit message, visible in the conversation, so the result stays properly integrated.
- Works with providers that report cancellation as an error (e.g. Amazon Bedrock's `This operation was aborted`).

## Install

```bash
pi install git:github.com/Syhids/pi-resume-aborted
```

Or try it without installing:

```bash
pi -e git:github.com/Syhids/pi-resume-aborted
```

## Notes

- On macOS, `alt` is the **Option (⌥)** key, and the terminal must send it as Meta. In iTerm2: *Settings → Profiles → Keys → General → Left Option key: Esc+*. In Terminal.app: *Settings → Profiles → Keyboard → Use Option as Meta key*. Otherwise, use `/skip` and `/fix`.

## License

MIT
