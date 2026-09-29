/**
 * resume-aborted
 *
 * Tras cancelar con Escape, muestra un aviso encima del editor y ofrece:
 *   "."  / /retry   → reintentar la tool cancelada (o continuar la respuesta)
 *   alt+c / /skip   → seguir sin repetir lo cancelado
 *   alt+x / /fix    → rellenar el editor para dar una corrección
 *
 * No re-ejecuta la tool por su cuenta: envía al modelo una instrucción explícita.
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
  /** "tool" = se cortó una tool en ejecución; "generating" = el modelo estaba escribiendo/pensando */
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

/** Analiza los mensajes de la ejecución para saber si terminó por cancelación y qué se cortó. */
function detectAbort(messages: any[]): AbortState | undefined {
  if (!messages?.length) return undefined;
  const last = messages[messages.length - 1];

  let i = messages.length - 1;
  if (last?.role === "assistant") {
    if (last.stopReason !== "aborted") return undefined;
    // Si el modelo ya había empezado a escribir/pensar, lo cortado fue la respuesta, no una tool.
    if ((last.content ?? []).length > 0) return { kind: "generating", tools: [] };
    i--;
  } else if (last?.role !== "toolResult") {
    return undefined; // Una ejecución normal no termina en toolResult; si no, no es cancelación.
  }

  // Resultados de tool inmediatamente anteriores
  const results: any[] = [];
  while (i >= 0 && messages[i]?.role === "toolResult") {
    results.unshift(messages[i]);
    i--;
  }
  const assistant = i >= 0 && messages[i]?.role === "assistant" ? messages[i] : undefined;
  const abortText = (r: any) =>
    /abort/i.test((r.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join(" "));
  let failed = results.filter((r) => r.isError && abortText(r));
  // Si la ejecución terminó en un toolResult, fue cortada ahí aunque el texto no diga "abort".
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
    return "Te interrumpí mientras respondías, pero no por lo que estabas haciendo. Continúa exactamente donde lo dejaste.";
  }
  const list = s.tools.map((t) => `- \`${describeTool(t, 200)}\``).join("\n");
  return (
    "Cancelé con Escape la ejecución de esta(s) tool(s), pero no por el enfoque:\n" +
    `${list}\n` +
    "Vuelve a ejecutarla(s) con los mismos argumentos (si puede haber quedado estado a medias, compruébalo antes) y continúa con la tarea."
  );
}

function skipPrompt(s: AbortState): string {
  const list = s.tools.map((t) => `\`${describeTool(t, 200)}\``).join(", ");
  return (
    `Cancelé a propósito ${list}. No la repitas. ` +
    "Continúa con la tarea sin ese paso (o por otro camino si es imprescindible)."
  );
}

function fixPrefill(s: AbortState): string {
  if (s.kind === "generating") return "Te paré porque ";
  const list = s.tools.map((t) => `\`${describeTool(t, 120)}\``).join(", ");
  return `No repitas ${list}. En su lugar, `;
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
      const extra = rest.length ? th.fg("dim", ` (+${rest.length} más)`) : "";
      lines.push(`${th.fg("warning", "⏸ Cancelado:")} ${th.fg("text", describeTool(first))}${extra}`);
      if (state.tools.some(isRisky)) {
        lines.push(th.fg("warning", "  ⚠ puede haber dejado estado a medias; el modelo lo comprobará antes de repetir"));
      }
      lines.push(
        th.fg("muted", "  ") +
          `${k('"."')}${th.fg("muted", " reintentar")}${sep}` +
          `${k(SHORTCUT_SKIP)}${th.fg("muted", " seguir sin repetir")}${sep}` +
          `${k(SHORTCUT_FIX)}${th.fg("muted", " corregir")}`,
      );
    } else {
      lines.push(`${th.fg("warning", "⏸ Respuesta interrumpida")}`);
      lines.push(
        th.fg("muted", "  ") +
          `${k('"."')}${th.fg("muted", " continuar")}${sep}` +
          `${k(SHORTCUT_FIX)}${th.fg("muted", " corregir")}`,
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
    if (!state) return ctx.ui.notify("No hay nada cancelado que saltar.", "info");
    if (state.kind !== "tool") return ctx.ui.notify("La cancelación no fue de una tool; usa \".\" o corrige.", "info");
    send(ctx, skipPrompt(state));
  };

  const doFix = (ctx: ExtensionContext) => {
    if (!state) return ctx.ui.notify("No hay nada cancelado que corregir.", "info");
    const prefill = fixPrefill(state);
    clear(ctx);
    ctx.ui.setEditorText(prefill);
  };

  // --- Ciclo de vida -------------------------------------------------------

  pi.on("session_start", (_e, ctx) => clear(ctx));
  pi.on("agent_start", (_e, ctx) => clear(ctx));

  pi.on("agent_end", (event, ctx) => {
    state = detectAbort(event.messages as any[]);
    if (state) render(ctx);
    else clear(ctx);
  });

  // "." justo después de cancelar → instrucción explícita. Cualquier otra entrada descarta el aviso.
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

  // --- Comandos y atajos ---------------------------------------------------

  pi.registerCommand("retry", {
    description: "Reintentar la tool cancelada con Escape (o continuar la respuesta)",
    handler: async (_args, ctx) => {
      if (!state) return ctx.ui.notify("No hay nada cancelado que reintentar.", "info");
      send(ctx, retryPrompt(state));
    },
  });

  pi.registerCommand("skip", {
    description: "Seguir sin repetir la tool cancelada con Escape",
    handler: async (_args, ctx) => doSkip(ctx),
  });

  pi.registerCommand("fix", {
    description: "Corregir al modelo tras cancelar con Escape",
    handler: async (_args, ctx) => doFix(ctx),
  });

  pi.registerShortcut(SHORTCUT_SKIP, {
    description: "resume-aborted: seguir sin repetir lo cancelado",
    handler: (ctx) => {
      if (state) doSkip(ctx);
    },
  });

  pi.registerShortcut(SHORTCUT_FIX, {
    description: "resume-aborted: corregir tras cancelar",
    handler: (ctx) => {
      if (state) doFix(ctx);
    },
  });
}
