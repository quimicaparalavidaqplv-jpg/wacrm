'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';

interface TelegramStatus {
  configured: boolean;
  has_token?: boolean;
  chat_id?: string;
  enabled?: boolean;
}

/**
 * Settings card for the Telegram sales-alert integration. Admins paste a
 * bot token + chat id; saving sends a real test message (server-side) so
 * a wrong token / missing group membership fails loudly before persisting.
 * The token is write-only — the server returns only a `has_token` flag.
 */
export function TelegramConfig() {
  const t = useTranslations('Settings.telegram');
  const { canManageMembers } = useAuth();
  const canEdit = canManageMembers;

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [chatId, setChatId] = useState('');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/config', { cache: 'no-store' });
      const data: TelegramStatus = await res.json();
      if (res.ok && data.configured) {
        setConfigured(true);
        setHasToken(!!data.has_token);
        setChatId(data.chat_id ?? '');
        setEnabled(data.enabled ?? true);
      }
    } catch {
      // A read failure just shows the empty form — no toast noise.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [load]);

  const save = async () => {
    if (!chatId.trim()) {
      toast.error(t('chatIdRequired'));
      return;
    }
    if (!configured && !token.trim()) {
      toast.error(t('tokenRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/telegram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId.trim(),
          enabled,
          // Send the token only when the admin typed a new one.
          ...(token.trim() ? { bot_token: token.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        setToken('');
        await load();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/telegram/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasToken(false);
        setChatId('');
        setToken('');
        setEnabled(true);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {/* Setup steps */}
            <ol className="list-decimal space-y-1 rounded-md border border-border bg-muted/40 py-3 pr-3 pl-7 text-xs text-muted-foreground">
              <li>{t('step1')}</li>
              <li>{t('step2')}</li>
              <li>{t('step3')}</li>
              <li>{t('step4')}</li>
            </ol>

            <div className="space-y-2">
              <Label htmlFor="tg-token">{t('tokenLabel')}</Label>
              <Input
                id="tg-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={hasToken ? t('tokenStored') : t('tokenPlaceholder')}
                disabled={!canEdit || saving}
              />
              {hasToken && (
                <p className="text-xs text-muted-foreground">{t('tokenHint')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="tg-chat">{t('chatIdLabel')}</Label>
              <Input
                id="tg-chat"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder={t('chatIdPlaceholder')}
                disabled={!canEdit || saving}
              />
              <p className="text-xs text-muted-foreground">{t('chatIdHint')}</p>
            </div>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={!canEdit || saving}
              />
              {t('enabledLabel')}
            </label>

            {canEdit ? (
              <div className="flex items-center justify-between pt-1">
                <Button onClick={save} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('saveTest')}
                </Button>
                {configured && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={remove}
                    disabled={removing}
                  >
                    {removing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    {t('remove')}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
