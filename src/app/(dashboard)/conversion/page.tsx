"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, TrendingUp, ShoppingCart, Hand, XCircle, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Counts {
  won: number;
  lost: number;
  escalated: number;
  bot: number;
  total: number;
}
interface ConversionData {
  range: string;
  counts: Counts;
  totalEscalated: number;
  conversionRate: number;
}

const RANGES = ["7d", "30d", "90d", "all"] as const;

export default function ConversionPage() {
  const t = useTranslations("Conversion");
  const [range, setRange] = useState<string>("30d");
  const [data, setData] = useState<ConversionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (r: string) => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/conversations/conversion?range=${r}`, {
        cache: "no-store",
      });
      const j = await res.json();
      if (res.ok) setData(j);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  const c = data?.counts;
  const tiles: {
    key: string;
    value: number;
    icon: typeof Bot;
    className: string;
  }[] = [
    { key: "won", value: c?.won ?? 0, icon: ShoppingCart, className: "text-chart-3" },
    { key: "escalated", value: c?.escalated ?? 0, icon: Hand, className: "text-primary" },
    { key: "lost", value: c?.lost ?? 0, icon: XCircle, className: "text-destructive" },
    { key: "bot", value: c?.bot ?? 0, icon: Bot, className: "text-muted-foreground" },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {/* Range selector */}
        <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                range === r
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(`range${r === "all" ? "All" : r}`)}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="mt-8 flex items-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("loading")}
        </div>
      ) : error ? (
        <div className="mt-8 rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("loadError")}
        </div>
      ) : (
        <>
          {/* Conversion rate — the headline number */}
          <Card className="mt-6">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <TrendingUp className="h-4 w-4 text-chart-3" />
                {t("conversionRate")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold text-foreground">
                {data?.conversionRate ?? 0}%
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("conversionRateHint", {
                  won: c?.won ?? 0,
                  total: data?.totalEscalated ?? 0,
                })}
              </p>
            </CardContent>
          </Card>

          {/* State breakdown */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tiles.map((tile) => {
              const Icon = tile.icon;
              return (
                <Card key={tile.key}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <Icon className={cn("h-4 w-4", tile.className)} />
                      {t(tile.key)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-foreground">
                      {tile.value}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            {t("totalHint", { total: c?.total ?? 0 })}
          </p>
        </>
      )}
    </div>
  );
}
