"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { DollarSign, ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

export type ConversionOutcome = "won" | "lost" | null;

/**
 * Header control to mark a conversation's sales outcome (Fase 2:
 * Conversión). Self-contained: PATCHes /api/conversations/[id]/conversion
 * and keeps its own optimistic state, so it needs nothing wired through
 * the inbox's conversation type beyond the id + current value.
 */
export function ConversionControl({
  conversationId,
  initialOutcome,
}: {
  conversationId: string;
  initialOutcome: ConversionOutcome;
}) {
  const t = useTranslations("Inbox.conversion");
  const [outcome, setOutcome] = useState<ConversionOutcome>(initialOutcome);
  const [busy, setBusy] = useState(false);

  // Sync to the real value of THIS conversation. The inbox reuses one
  // MessageThread instance across conversation switches, so this control
  // doesn't remount — without this, the local state from the previous chat
  // would stick and look like every chat has the same mark. Re-reads on
  // every conversationId change, straight from the row (RLS-scoped).
  useEffect(() => {
    let cancelled = false;
    setOutcome(initialOutcome);
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("conversations")
        .select("conversion_outcome")
        .eq("id", conversationId)
        .maybeSingle();
      if (!cancelled && data) {
        setOutcome((data.conversion_outcome as ConversionOutcome) ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // initialOutcome intentionally omitted: it's just the first-paint
    // seed; the fetch is the source of truth and re-runs per conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const set = async (next: ConversionOutcome) => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/conversion`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: next }),
        },
      );
      if (res.ok) {
        setOutcome(next);
        toast.success(
          next === "won"
            ? t("markedWon")
            : next === "lost"
              ? t("markedLost")
              : t("cleared"),
        );
      } else {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? t("error"));
      }
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(false);
    }
  };

  const label =
    outcome === "won" ? t("won") : outcome === "lost" ? t("lost") : t("mark");
  const color =
    outcome === "won"
      ? "text-chart-3"
      : outcome === "lost"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
          color,
        )}
        title={t("title")}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <DollarSign className="h-3 w-3" />
        )}
        <span className="hidden sm:inline">{label}</span>
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem onClick={() => set("won")}>
          🟢 {t("won")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => set("lost")}>
          🔴 {t("lost")}
        </DropdownMenuItem>
        {outcome !== null && (
          <DropdownMenuItem onClick={() => set(null)}>
            {t("clear")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
