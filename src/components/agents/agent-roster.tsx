'use client';

// ============================================================
// Agent roster — create, edit, enable/disable the specialised agents
// the router picks between (migration 037).
//
// NOTE: copy is written in Spanish inline rather than through
// next-intl. The app currently ships only `messages/en.json`; when the
// Spanish dictionary lands, these strings move into it and this file
// switches to `useTranslations`. Kept deliberately in one place so that
// migration is a single mechanical pass.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  systemPrompt: string;
  isActive: boolean;
  isFallback: boolean;
  sortOrder: number;
}

/** Editor target: 'new' when creating, an agent id when editing, null when closed. */
type EditTarget = 'new' | string | null;

const EMPTY_DRAFT = {
  name: '',
  slug: '',
  description: '',
  systemPrompt: '',
  isFallback: false,
};

/**
 * Derive a valid slug from the agent's name so operators don't have to
 * think about the router's identifier format. Strips accents first —
 * "Información General" must become `informacion_general`, not
 * `informaci_n_general`.
 */
function slugify(name: string): string {
  return name
    .normalize('NFD')
    // Combining marks are written as escapes, not literals — literals
    // are invisible in an editor and get mangled by any tooling that
    // re-normalises the file.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export function AgentRoster({ canEdit }: { canEdit: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  // True once the operator edits the slug by hand, which stops the
  // name→slug mirroring from overwriting their choice.
  const slugTouched = useRef(false);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/agents');
      const data = await res.json();
      if (res.ok) setAgents(data.agents ?? []);
      else toast.error(data.error ?? 'No se pudieron cargar los agentes');
    } catch {
      toast.error('No se pudieron cargar los agentes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const openNew = () => {
    slugTouched.current = false;
    setDraft(EMPTY_DRAFT);
    setEditing('new');
  };

  const openEdit = (agent: Agent) => {
    // Editing an existing agent: its slug is already set and changing it
    // silently would break routing, so never auto-mirror here.
    slugTouched.current = true;
    setDraft({
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      isFallback: agent.isFallback,
    });
    setEditing(agent.id);
  };

  const closeEditor = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const onNameChange = (name: string) => {
    setDraft((d) => ({
      ...d,
      name,
      slug: slugTouched.current ? d.slug : slugify(name),
    }));
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error('El nombre es obligatorio');
      return;
    }
    if (!draft.slug.trim()) {
      toast.error('El identificador es obligatorio');
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/agents' : `/api/ai/agents/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.name.trim(),
            slug: draft.slug.trim(),
            description: draft.description.trim(),
            system_prompt: draft.systemPrompt.trim(),
            is_fallback: draft.isFallback,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo guardar el agente');
        return;
      }
      toast.success(isNew ? 'Agente creado' : 'Agente actualizado');
      closeEditor();
      await fetchAgents();
    } catch {
      toast.error('No se pudo guardar el agente');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (agent: Agent) => {
    // Optimistic: the switch should feel instant. Reverted below if the
    // write fails, so the UI can never claim an agent is on when the
    // engine would still skip it.
    const next = !agent.isActive;
    setAgents((list) =>
      list.map((a) => (a.id === agent.id ? { ...a, isActive: next } : a)),
    );
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setAgents((list) =>
        list.map((a) =>
          a.id === agent.id ? { ...a, isActive: agent.isActive } : a,
        ),
      );
      toast.error('No se pudo cambiar el estado del agente');
    }
  };

  const remove = async (agent: Agent) => {
    if (
      !window.confirm(
        `¿Eliminar el agente "${agent.name}"? Esta acción no se puede deshacer.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo eliminar el agente');
        return;
      }
      toast.success('Agente eliminado');
      await fetchAgents();
    } catch {
      toast.error('No se pudo eliminar el agente');
    }
  };

  const installTemplates = async () => {
    setSeeding(true);
    try {
      const res = await fetch('/api/ai/agents/seed', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudieron instalar las plantillas');
        return;
      }
      if (data.created === 0) {
        toast.info('Ya tienes todos los agentes de la plantilla instalados');
      } else {
        toast.success(
          `${data.created} agente(s) instalado(s)` +
            (data.skipped ? ` — ${data.skipped} ya existían` : ''),
        );
      }
      await fetchAgents();
    } catch {
      toast.error('No se pudieron instalar las plantillas');
    } finally {
      setSeeding(false);
    }
  };

  const hasFallback = agents.some((a) => a.isFallback);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            Agentes especializados
          </CardTitle>
          <CardDescription>
            Cada agente atiende un tipo de conversación. Cuando llega un
            mensaje, el sistema elige automáticamente cuál responde.
          </CardDescription>
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={installTemplates}
              disabled={seeding}
            >
              {seeding ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-4 w-4" />
              )}
              Instalar plantillas
            </Button>
            <Button size="sm" onClick={openNew}>
              <Plus className="mr-1.5 h-4 w-4" />
              Nuevo agente
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Without a fallback, an unclassifiable message hands off to a
            human instead of being answered — worth saying out loud. */}
        {!loading && agents.length > 0 && !hasFallback && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            Ningún agente está marcado como <strong>predeterminado</strong>. Si
            el sistema no logra clasificar un mensaje, lo pasará a un humano en
            lugar de responder.
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando agentes…
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-10 text-center">
            <Bot className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">
              Todavía no tienes agentes
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Instala las plantillas para empezar con un equipo completo, o crea
              uno desde cero.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {agent.name}
                    </span>
                    {agent.isFallback && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                        <Star className="h-3 w-3" />
                        Predeterminado
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    <code className="text-[11px]">{agent.slug}</code>
                    {agent.description ? ` — ${agent.description}` : ''}
                  </p>
                </div>

                {canEdit ? (
                  <>
                    <Switch
                      checked={agent.isActive}
                      onCheckedChange={() => toggleActive(agent)}
                      aria-label={`Activar ${agent.name}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(agent)}
                      aria-label={`Editar ${agent.name}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(agent)}
                      aria-label={`Eliminar ${agent.name}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {agent.isActive ? 'Activo' : 'Inactivo'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">Nombre</Label>
                <Input
                  id="agent-name"
                  value={draft.name}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="Ventas al Mayor"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-slug">Identificador</Label>
                <Input
                  id="agent-slug"
                  value={draft.slug}
                  onChange={(e) => {
                    slugTouched.current = true;
                    setDraft((d) => ({ ...d, slug: e.target.value }));
                  }}
                  placeholder="ventas_mayor"
                />
                <p className="text-xs text-muted-foreground">
                  Solo minúsculas, números y guiones bajos.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-description">¿Cuándo se activa?</Label>
              <Textarea
                id="agent-description"
                rows={2}
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                placeholder="Cuando el cliente pregunta por precios al mayor o compra por volumen."
              />
              <p className="text-xs text-muted-foreground">
                Esta frase es la que lee el clasificador para decidir qué agente
                responde. Sé concreto sobre el disparador.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-prompt">Instrucciones del agente</Label>
              <Textarea
                id="agent-prompt"
                rows={12}
                value={draft.systemPrompt}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, systemPrompt: e.target.value }))
                }
                placeholder={'## ROL\nEres…\n\n## TONO\n…'}
                className="font-mono text-xs"
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="agent-fallback"
                checked={draft.isFallback}
                onCheckedChange={(v) =>
                  setDraft((d) => ({ ...d, isFallback: v }))
                }
              />
              <Label htmlFor="agent-fallback" className="cursor-pointer">
                Agente predeterminado
              </Label>
              <span className="text-xs text-muted-foreground">
                Responde cuando no se puede clasificar el mensaje.
              </span>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeEditor} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Guardar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
