'use client';

import { useEffect, useState } from 'react';
import { Bot, Sparkles, Settings2, BarChart3, Users } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AgentRoster } from '@/components/agents/agent-roster';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Tab = 'roster' | 'playground' | 'setup' | 'usage';

export default function AgentsPage() {
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'roster' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Agentes IA
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Define agentes especializados, pruébalos en el sandbox y deja que
        respondan solos en la bandeja de entrada.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="roster">
              <Users className="mr-1.5 h-4 w-4" /> Agentes
            </TabsTrigger>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Playground
            </TabsTrigger>
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Setup
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage">
                <BarChart3 className="mr-1.5 h-4 w-4" /> Usage
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="roster" className="mt-4">
            <AgentRoster canEdit={canEditSettings(accountRole ?? 'viewer')} />
          </TabsContent>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
