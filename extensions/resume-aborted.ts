/**
 * resume-aborted
 *
 * After cancelling with Escape, shows a notice above the editor and offers:
 *   "."  / /retry   → retry the aborted tool (or continue the response)
 *   alt+c / /skip   → move on without repeating what was aborted
 *   alt+x / /fix    → prefill the editor so you can give a correction
 *
 * It never re-runs the tool itself: it sends the model an explicit instruction.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "resume-aborted";
const SHORTCUT_SKIP = "alt+c";
const SHORTCUT_FIX = "alt+x";

interface AbortedTool {
  name: string;
  args: Record<string, unknown>;
}

interface AbortState {
  /** "tool" = a running tool was cut off; "generating" = the model was writing/thinking */
  kind: "tool" | "generating";
  tools: AbortedTool[];
}

const RISKY_BASH =
  /(\brm\b|\bmv\b|\bgit\s+(push|commit|reset|rebase|merge|checkout|stash|clean)\b|\b(npm|pnpm|yarn|bun)\s+(publish|install|add|remove)\b|\bpip\s+install\b|\bbrew\s+(install|uninstall|upgrade)\b|\bdocker\b|\bkubectl\b|\bterraform\b|\bmigrat|\bdeploy\b|\bdrop\s+table\b|\bdelete\s+from\b|curl[^|]*-X\s*(POST|PUT|PATCH|DELETE)|(^|[^>])>{1,2}\s*[^&\s])/i;

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeTool(t: AbortedTool, max = 70): string {
  const a = t.args ?? {};
  let detail: string;
  if (typeof a.command === "string") detail = a.command;
  else if (typeof a.path === "string") detail = a.path;
  else if (typeof a.pattern === "string") detail = a.pattern;
  else detail = JSON.stringify(a);
  return `${t.name} · ${oneLine(detail, max)}`;
}

function isRisky(t: AbortedTool): boolean {
  if (t.name === "write" || t.name === "edit") return true;
  if (t.name === "bash" && typeof t.args?.command === "string") return RISKY_BASH.test(t.args.command);
  return false;
}

/** Inspect the run's messages to tell whether it ended by cancellation and what was cut off. */
function detectAbort(messages: any[]): AbortState | undefined {
  if (!messages?.length) return undefined;
  const last = messages[messages.length - 1];

  let i = messages.length - 1;
  if (last?.role === "assistant") {
    // Some providers (e.g. Bedrock) report cancellation as an error: "This operation was aborted".
    const aborted =
      last.stopReason === "aborted" ||
      (last.stopReason === "error" && /abort/i.test(String(last.errorMessage ?? "")));
    if (!aborted) return undefined;
    // If the model had already started writing/thinking, the response was cut off, not a tool.
    if ((last.content ?? []).length > 0) return { kind: "generating", tools: [] };
    i--;
  } else if (last?.role !== "toolResult") {
    return undefined; // A normal run never ends on a toolResult; anything else is not a cancellation.
  }

  // Tool results immediately before
  const results: any[] = [];
  while (i >= 0 && messages[i]?.role === "toolResult") {
    results.unshift(messages[i]);
    i--;
  }
  const assistant = i >= 0 && messages[i]?.role === "assistant" ? messages[i] : undefined;
  const abortText = (r: any) =>
    /abort/i.test((r.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join(" "));
  let failed = results.filter((r) => r.isError && abortText(r));
  // If the run ended on a toolResult, it was cut off there even if the text does not say "abort".
  if (failed.length === 0 && last?.role === "toolResult") failed = results.filter((r) => r.isError);

  if (assistant && failed.length > 0) {
    const calls: any[] = (assistant.content ?? []).filter((c: any) => c?.type === "toolCall");
    const tools = failed.map((r) => {
      const call = calls.find((c) => c.id === r.toolCallId);
      return { name: call?.name ?? r.toolName ?? "tool", args: (call?.arguments ?? {}) as Record<string, unknown> };
    });
    return { kind: "tool", tools };
  }

  return { kind: "generating", tools: [] };
}

function retryPrompt(s: AbortState): string {
  if (s.kind === "generating") {
    return "I interrupted you while you were responding, but not because of what you were doing. Continue exactly where you left off.";
  }
  const many = s.tools.length > 1;
  const list = s.tools.map((t) => `- \`${describeTool(t, 200)}\``).join("\n");
  return (
    `I cancelled ${many ? "these tool calls" : "this tool call"} with Escape, but not because of the approach:\n` +
    `${list}\n` +
    `Run ${many ? "them" : "it"} again with the same arguments (if ${many ? "they" : "it"} may have left partial state behind, check that first) and continue with the task.`
  );
}

function skipPrompt(s: AbortState): string {
  const list = s.tools.map((t) => `\`${describeTool(t, 200)}\``).join(", ");
  return (
    `I intentionally cancelled ${list}. Do not repeat ${s.tools.length > 1 ? "them" : "it"}. ` +
    "Continue with the task without that step (or find another way if it is essential)."
  );
}

function fixPrefill(s: AbortState): string {
  if (s.kind === "generating") return "I stopped you because ";
  const list = s.tools.map((t) => `\`${describeTool(t, 120)}\``).join(", ");
  return `Do not repeat ${list}. Instead, `;
}

export default function (pi: ExtensionAPI) {
  let state: AbortState | undefined;

  const clear = (ctx: ExtensionContext) => {
    state = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const render = (ctx: ExtensionContext) => {
    if (!state || !ctx.hasUI) return;
    const th = ctx.ui.theme;
    const lines: string[] = [];
    const k = (key: string) => th.fg("accent", key);
    const sep = th.fg("dim", "  ·  ");

    if (state.kind === "tool") {
      const [first, ...rest] = state.tools;
      const extra = rest.length ? th.fg("dim", ` (+${rest.length} more)`) : "";
      lines.push(`${th.fg("warning", "⏸ Cancelled:")} ${th.fg("text", describeTool(first))}${extra}`);
      if (state.tools.some(isRisky)) {
        lines.push(th.fg("warning", "  ⚠ may have left partial state behind; the model will check before retrying"));
      }
      lines.push(
        th.fg("muted", "  ") +
          `${k('"."')}${th.fg("muted", " retry")}${sep}` +
          `${k(SHORTCUT_SKIP)}${th.fg("muted", " skip")}${sep}` +
          `${k(SHORTCUT_FIX)}${th.fg("muted", " correct")}`,
      );
    } else {
      lines.push(`${th.fg("warning", "⏸ Response interrupted")}`);
      lines.push(
        th.fg("muted", "  ") +
          `${k('"."')}${th.fg("muted", " continue")}${sep}` +
          `${k(SHORTCUT_FIX)}${th.fg("muted", " correct")}`,
      );
    }
    ctx.ui.setWidget(WIDGET_KEY, lines);
  };

  const send = (ctx: ExtensionContext, text: string) => {
    clear(ctx);
    if (ctx.isIdle()) pi.sendUserMessage(text);
    else pi.sendUserMessage(text, { deliverAs: "followUp" });
  };

  const doSkip = (ctx: ExtensionContext) => {
    if (!state) return ctx.ui.notify("Nothing cancelled to skip.", "info");
    if (state.kind !== "tool") return ctx.ui.notify("The cancellation was not a tool call; use \".\" or correct.", "info");
    send(ctx, skipPrompt(state));
  };

  const doFix = (ctx: ExtensionContext) => {
    if (!state) return ctx.ui.notify("Nothing cancelled to correct.", "info");
    const prefill = fixPrefill(state);
    clear(ctx);
    ctx.ui.setEditorText(prefill);
  };

  // --- Lifecycle -----------------------------------------------------------

  pi.on("session_start", (_e, ctx) => clear(ctx));
  pi.on("agent_start", (_e, ctx) => clear(ctx));

  pi.on("agent_end", (event, ctx) => {
    state = detectAbort(event.messages as any[]);
    if (state) render(ctx);
    else clear(ctx);
  });

  // "." right after cancelling → explicit instruction. Any other input dismisses the notice.
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!state) return { action: "continue" };
    const current = state;
    clear(ctx);
    if (event.text.trim() === "." && !event.images?.length) {
      return { action: "transform", text: retryPrompt(current) };
    }
    return { action: "continue" };
  });

  // --- Commands and shortcuts ---------------------------------------------------

  pi.registerCommand("retry", {
    description: "Retry the tool cancelled with Escape (or continue the response)",
    handler: async (_args, ctx) => {
      if (!state) return ctx.ui.notify("Nothing cancelled to retry.", "info");
      send(ctx, retryPrompt(state));
    },
  });

  pi.registerCommand("skip", {
    description: "Move on without repeating the tool cancelled with Escape",
    handler: async (_args, ctx) => doSkip(ctx),
  });

  pi.registerCommand("fix", {
    description: "Correct the model after cancelling with Escape",
    handler: async (_args, ctx) => doFix(ctx),
  });

  pi.registerShortcut(SHORTCUT_SKIP, {
    description: "resume-aborted: skip what was cancelled",
    handler: (ctx) => {
      if (state) doSkip(ctx);
    },
  });

  pi.registerShortcut(SHORTCUT_FIX, {
    description: "resume-aborted: correct after cancelling",
    handler: (ctx) => {
      if (state) doFix(ctx);
    },
  });
}
