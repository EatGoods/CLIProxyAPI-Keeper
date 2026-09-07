import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconSettings } from '@/components/ui/icons';
import { useScrollBoundaryContainment } from '@/hooks/useScrollBoundaryContainment';
import type { CpaApiKeyLimitsInput, CpaApiKeySettingsItem } from '@/lib/types';
import styles from '@/pages/UsagePage.module.scss';

type ClipboardWriter = Pick<Clipboard, 'writeText'>;
type CopyTextArea = {
  value: string;
  readOnly: boolean;
  style: {
    position?: string;
    opacity?: string;
    pointerEvents?: string;
    top?: string;
    left?: string;
  };
  setAttribute: (name: string, value: string) => void;
  focus: () => void;
  select: () => void;
  remove?: () => void;
};
type CopyDocument = {
  body?: {
    appendChild: (node: CopyTextArea) => unknown;
    removeChild?: (node: CopyTextArea) => unknown;
  };
  createElement?: (tagName: 'textarea') => CopyTextArea;
  execCommand?: (command: string) => boolean;
};
type CopyContext = {
  clipboard?: ClipboardWriter;
  document?: CopyDocument;
};

export function getApiKeySettingsVisibleKey(item: CpaApiKeySettingsItem, showFullApiKeys: boolean) {
  return showFullApiKeys && item.apiKey ? item.apiKey : item.displayKey;
}

export async function copyApiKeyToClipboard(apiKey: string, context: CopyContext = {}) {
  if (!apiKey) {
    return;
  }
  const clipboard = context.clipboard ?? globalThis.navigator?.clipboard;
  if (clipboard) {
    try {
      await clipboard.writeText(apiKey);
      return;
    } catch {
      // HTTP LAN pages can block navigator.clipboard; fall back to a selected textarea copy.
    }
  }
  const documentRef = context.document ?? (typeof document !== 'undefined' ? document as unknown as CopyDocument : undefined);
  const textarea = documentRef?.createElement?.('textarea');
  if (!documentRef?.body || !documentRef.execCommand || !textarea) {
    throw new Error('clipboard is not available');
  }
  textarea.value = apiKey;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.top = '0';
  textarea.style.left = '0';
  documentRef.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!documentRef.execCommand('copy')) {
      throw new Error('copy command failed');
    }
  } finally {
    if (textarea.remove) {
      textarea.remove();
    } else {
      documentRef.body.removeChild?.(textarea);
    }
  }
}

export interface ApiKeySettingsCardProps {
  apiKeys: CpaApiKeySettingsItem[];
  loading?: boolean;
  savingId?: string | null;
  onSaveAlias: (id: string, keyAlias: string) => void | Promise<void>;
  onSaveLimits: (id: string, limits: CpaApiKeyLimitsInput) => void | Promise<void>;
  onResetLimits: (id: string) => void | Promise<void>;
  onNotice?: (kind: 'success' | 'info' | 'error', message: string) => void;
}

export function ApiKeySettingsCard({ apiKeys, loading = false, savingId = null, onSaveAlias, onSaveLimits, onResetLimits, onNotice }: ApiKeySettingsCardProps) {
  const { t } = useTranslation();
  const [showFullApiKeys, setShowFullApiKeys] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiKeySettingsBodyRef = useRef<HTMLDivElement | null>(null);
  useScrollBoundaryContainment(apiKeySettingsBodyRef);
  const initialAliases = useMemo(
    () => Object.fromEntries(apiKeys.map((item) => [item.id, item.keyAlias])),
    [apiKeys],
  );
  const [draftAliases, setDraftAliases] = useState<Record<string, string>>(initialAliases);
  const [editingLimits, setEditingLimits] = useState<CpaApiKeySettingsItem | null>(null);
  const [limitDraft, setLimitDraft] = useState<CpaApiKeyLimitsInput | null>(null);

  const openLimits = (item: CpaApiKeySettingsItem) => {
    setEditingLimits(item);
    setLimitDraft({
      quotaLimitUsd: item.quotaLimitUsd,
      rateLimitEnabled: item.rateLimitEnabled,
      fiveHourLimitUsd: item.fiveHourLimitUsd,
      dailyLimitUsd: item.dailyLimitUsd,
      sevenDayLimitUsd: item.sevenDayLimitUsd,
      expiresAt: item.expiresAt,
    });
  };

  const setAmount = (field: keyof Pick<CpaApiKeyLimitsInput, 'quotaLimitUsd' | 'fiveHourLimitUsd' | 'dailyLimitUsd' | 'sevenDayLimitUsd'>, value: string) => {
    setLimitDraft((current) => current ? { ...current, [field]: Math.max(0, Number(value) || 0) } : current);
  };

  useEffect(() => {
    setDraftAliases(initialAliases);
  }, [initialAliases]);

  useEffect(() => {
    setEditingLimits((current) => current ? apiKeys.find((item) => item.id === current.id) ?? null : null);
  }, [apiKeys]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const handleCopyApiKey = useCallback(async (item: CpaApiKeySettingsItem) => {
    try {
      await copyApiKeyToClipboard(item.apiKey);
      setCopiedId(item.id);
      onNotice?.('success', t('usage_stats.api_key_settings_copy_success'));
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = setTimeout(() => setCopiedId(null), 1600);
    } catch {
      setCopiedId(null);
      onNotice?.('error', t('usage_stats.api_key_settings_copy_failed'));
    }
  }, [onNotice, t]);
  const toggleLabel = showFullApiKeys
    ? t('usage_stats.api_key_settings_hide_full')
    : t('usage_stats.api_key_settings_show_full');

  return (
    <Card
      title={t('usage_stats.api_key_settings_title')}
      subtitle={t('usage_stats.api_key_settings_subtitle')}
      titleMeta={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.apiKeyVisibilityToggle} ${showFullApiKeys ? styles.apiKeyVisibilityToggleActive : ''}`.trim()}
          onClick={() => setShowFullApiKeys((current) => !current)}
          aria-label={toggleLabel}
          aria-pressed={showFullApiKeys}
          title={toggleLabel}
        >
          {showFullApiKeys ? <IconEye size={16} /> : <IconEyeOff size={16} />}
        </Button>
      }
      className={`${styles.detailsFixedCard} ${styles.apiKeySettingsCard}`}
    >
      <div ref={apiKeySettingsBodyRef} className={styles.apiKeySettingsBody}>
        {loading && apiKeys.length === 0 ? (
          <div className={styles.hint}>{t('common.loading')}</div>
        ) : apiKeys.length === 0 ? (
          <div className={styles.hint}>{t('usage_stats.api_key_settings_empty')}</div>
        ) : (
          <div className={styles.apiKeySettingsList}>
            {apiKeys.map((item) => {
              const draftAlias = draftAliases[item.id] ?? '';
              const disabled = savingId === item.id;
              const apiKey = getApiKeySettingsVisibleKey(item, showFullApiKeys);
              const copyLabel = copiedId === item.id ? t('usage_stats.api_key_settings_copied') : t('usage_stats.api_key_settings_copy');
              return (
                <div key={item.id} className={styles.apiKeySettingsItem}>
                  <div className={styles.apiKeySettingsSummary}>
                    <span className={styles.apiKeyFieldLabel}>{t('usage_stats.api_key_settings_display_key')}</span>
                    <div className={styles.apiKeySettingsNameRow}>
                      <span className={styles.apiKeySettingsName} title={apiKey}>{apiKey}</span>
                      <button
                        type="button"
                        className={`${styles.apiKeySettingsCopyIconButton} ${copiedId === item.id ? styles.apiKeySettingsCopyIconButtonCopied : ''}`.trim()}
                        onClick={() => void handleCopyApiKey(item)}
                        disabled={!item.apiKey}
                        aria-label={copyLabel}
                        title={copyLabel}
                      >
                        {copiedId === item.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </button>
                    </div>
                  </div>
                  <div className={styles.apiKeySettingsForm}>
                    <label className={styles.apiKeyAliasField}>
                      <span className={styles.apiKeyAliasLabel}>{t('usage_stats.api_key_settings_alias')}</span>
                      <Input
                        value={draftAlias}
                        onChange={(event) => setDraftAliases((current) => ({ ...current, [item.id]: event.target.value }))}
                        placeholder={apiKey}
                        aria-label={`${t('usage_stats.api_key_settings_alias')} ${apiKey}`}
                        className={`${styles.usagePillControl} ${styles.apiKeyAliasInput}`.trim()}
                        disabled={disabled}
                      />
                    </label>
                    <div className={styles.apiKeySettingsActions}>
                      <Button
                        variant="primary"
                        size="sm"
                        appearance="action"
                        className={styles.apiKeySettingsSaveButton}
                        onClick={() => onSaveAlias(item.id, draftAlias)}
                        disabled={disabled}
                      >
                        {disabled ? t('usage_stats.api_key_settings_saving') : t('common.save')}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        appearance="action"
                        onClick={() => openLimits(item)}
                        disabled={disabled}
                        aria-label={t('usage_stats.api_key_limits_configure')}
                        title={t('usage_stats.api_key_limits_configure')}
                      >
                        <IconSettings size={15} />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Modal
        open={editingLimits !== null && limitDraft !== null}
        title={t('usage_stats.api_key_limits_title')}
        onClose={() => setEditingLimits(null)}
        closeDisabled={Boolean(editingLimits && savingId === editingLimits.id)}
        width={520}
        footer={
          <>
            <Button variant="secondary" appearance="action" onClick={() => editingLimits && onResetLimits(editingLimits.id)} disabled={!editingLimits || savingId === editingLimits.id}>
              {t('usage_stats.api_key_limits_reset')}
            </Button>
            <Button variant="primary" appearance="action" onClick={() => editingLimits && limitDraft && onSaveLimits(editingLimits.id, limitDraft)} loading={Boolean(editingLimits && savingId === editingLimits.id)}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editingLimits && limitDraft && (
          <div className={styles.apiKeyLimitsForm}>
            <div className={styles.apiKeyLimitsUsage}>{t('usage_stats.api_key_limits_total_used', { value: editingLimits.quotaUsedUsd.toFixed(4) })}</div>
            {!editingLimits.costAvailable && <div className={styles.errorBox}>{t('usage_stats.api_key_limits_pricing_unavailable')}</div>}
            <Input label={t('usage_stats.api_key_limits_quota')} type="number" min="0" step="0.0001" value={limitDraft.quotaLimitUsd} onChange={(event) => setAmount('quotaLimitUsd', event.target.value)} disabled={savingId === editingLimits.id} />
            <label className={styles.apiKeyLimitsToggle}>
              <input type="checkbox" checked={limitDraft.rateLimitEnabled} onChange={(event) => setLimitDraft({ ...limitDraft, rateLimitEnabled: event.target.checked })} disabled={savingId === editingLimits.id} />
              <span>{t('usage_stats.api_key_limits_rate_enabled')}</span>
            </label>
            <div className={styles.apiKeyLimitsGrid}>
              <Input label={t('usage_stats.api_key_limits_5h', { value: editingLimits.fiveHourUsedUsd.toFixed(4) })} type="number" min="0" step="0.0001" value={limitDraft.fiveHourLimitUsd} onChange={(event) => setAmount('fiveHourLimitUsd', event.target.value)} disabled={!limitDraft.rateLimitEnabled || savingId === editingLimits.id} />
              <Input label={t('usage_stats.api_key_limits_day', { value: editingLimits.dailyUsedUsd.toFixed(4) })} type="number" min="0" step="0.0001" value={limitDraft.dailyLimitUsd} onChange={(event) => setAmount('dailyLimitUsd', event.target.value)} disabled={!limitDraft.rateLimitEnabled || savingId === editingLimits.id} />
              <Input label={t('usage_stats.api_key_limits_7d', { value: editingLimits.sevenDayUsedUsd.toFixed(4) })} type="number" min="0" step="0.0001" value={limitDraft.sevenDayLimitUsd} onChange={(event) => setAmount('sevenDayLimitUsd', event.target.value)} disabled={!limitDraft.rateLimitEnabled || savingId === editingLimits.id} />
              <Input label={t('usage_stats.api_key_limits_expiry')} type="datetime-local" value={limitDraft.expiresAt ? limitDraft.expiresAt.slice(0, 16) : ''} onChange={(event) => setLimitDraft({ ...limitDraft, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} disabled={savingId === editingLimits.id} />
            </div>
            <div className={styles.hint}>{t('usage_stats.api_key_limits_zero_hint')}</div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
