"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Clock,
  RefreshCw,
  MessageCircle,
  ArrowRight,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface PendingContact {
  id: string;
  name: string | null;
  phone: string | null;
}
interface PendingConversation {
  id: string;
  escalated_at: string;
  escalation_reason: "compra" | "soporte_humano" | "handoff" | null;
  last_message_text: string | null;
  contact: PendingContact | null;
}

const REASON_STYLE: Record<
  string,
  { key: string; className: string }
> = {
  compra: {
    key: "reasonCompra",
    className: "border-chart-3/40 bg-chart-3/10 text-chart-3",
  },
  soporte_humano: {
    key: "reasonSoporte",
    className: "border-primary/40 bg-primary/10 text-primary",
  },
  handoff: {
    key: "reasonHandoff",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  },
};

/** Digits-only wa.me link, or null when there's no phone. */
function waLink(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}` : null;
}

export default function PendingPage() {
  const t = useTranslations("Pending");
  const [items, setItems] = useState<PendingConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/conversations/pending", {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.ok) setItems(data.conversations ?? []);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live "waiting for" labels: re-render every 30s so the ages stay fresh
  // without a refetch.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const waitingLabel = (iso: string): string => {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return t("waitingM", { min: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t("waitingH", { hr: hrs });
    return t("waitingD", { day: Math.floor(hrs / 24) });
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {t("refresh")}
        </Button>
      </div>

      <div className="mt-6">
        {loading && items.length === 0 ? (
          <div className="flex items-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t("loadError")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-10 text-center">
            <CheckCircle2 className="h-8 w-8 text-chart-3" />
            <p className="text-sm font-medium text-foreground">{t("empty")}</p>
            <p className="text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((c) => {
              const reason = c.escalation_reason
                ? REASON_STYLE[c.escalation_reason]
                : null;
              const name = c.contact?.name || c.contact?.phone || t("unknownContact");
              const wa = waLink(c.contact?.phone ?? null);
              return (
                <li
                  key={c.id}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{name}</span>
                    {reason && (
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          reason.className,
                        )}
                      >
                        {t(reason.key)}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {waitingLabel(c.escalated_at)}
                    </span>
                  </div>
                  {c.last_message_text && (
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {c.last_message_text}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link href={`/inbox?c=${c.id}`} />}
                    >
                      {t("openInInbox")}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                    {wa && (
                      <Button
                        size="sm"
                        render={
                          <a href={wa} target="_blank" rel="noopener noreferrer" />
                        }
                      >
                        <MessageCircle className="mr-2 h-4 w-4" />
                        {t("replyWhatsapp")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
