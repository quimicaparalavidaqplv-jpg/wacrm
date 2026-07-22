"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Count of "pending" conversations — escalated by the bot but not yet
 * taken by a human (`escalated_at` set, `assigned_agent_id` null). Drives
 * the sidebar badge on the Pending nav entry.
 *
 * RLS on `conversations` scopes reads to the user's account, so no
 * explicit account filter is needed. On any conversations change we
 * refetch the count rather than trying to reconstruct it from the payload
 * (escalation + assignment both move the count, and payload.old needs
 * REPLICA IDENTITY FULL) — a single head-count query is cheap.
 */
export function usePendingCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const refetch = async () => {
      const { count: c, error } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .not("escalated_at", "is", null)
        .is("assigned_agent_id", null);
      if (cancelled || error) return;
      setCount(c ?? 0);
    };

    void refetch();

    const channel = supabase
      .channel("conversations-pending-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => {
          void refetch();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return count;
}
