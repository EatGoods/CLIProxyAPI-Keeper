import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpamcEmbedSearch, isCPAMCEmbed, notifyCPAMCEmbedReady, openCPAMCAIProviders, parseCPAMCPreferences } from '../cpamcEmbed';

describe('CPAMC embed query helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects only the CPAMC embed mode', () => {
    expect(isCPAMCEmbed('?embed=cpamc')).toBe(true);
    expect(isCPAMCEmbed('?mode=cpamc')).toBe(true);
    expect(isCPAMCEmbed('embed=cpamc')).toBe(true);
    expect(isCPAMCEmbed('?foo=1&embed=cpamc')).toBe(true);
    expect(isCPAMCEmbed('?embed=iframe&embed=cpamc')).toBe(true);
    expect(isCPAMCEmbed('?mode=normal&mode=cpamc')).toBe(true);
    expect(isCPAMCEmbed('?embed=iframe')).toBe(false);
    expect(isCPAMCEmbed('?embed=CPAMC')).toBe(false);
    expect(isCPAMCEmbed('')).toBe(false);
  });

  it('preserves only the CPAMC embed query for app navigation', () => {
    expect(cpamcEmbedSearch('?embed=cpamc')).toBe('?embed=cpamc');
    expect(cpamcEmbedSearch('?mode=cpamc')).toBe('?embed=cpamc');
    expect(cpamcEmbedSearch('?foo=1&embed=cpamc&bar=2')).toBe('?embed=cpamc');
    expect(cpamcEmbedSearch('?embed=iframe&embed=cpamc')).toBe('?embed=cpamc');
    expect(cpamcEmbedSearch('?embed=iframe')).toBe('');
    expect(cpamcEmbedSearch('')).toBe('');
  });

  it('notifies the parent frame only in CPAMC embed mode', () => {
    const messages: unknown[] = [];
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      parent: { postMessage: (message: unknown) => messages.push(message) },
    });

    notifyCPAMCEmbedReady('?embed=iframe');
    notifyCPAMCEmbedReady('?embed=cpamc');

    expect(messages).toEqual([{ type: 'cpa-usage-keeper:ready' }]);
  });

  it('maps CPAMC theme and language preferences', () => {
    expect(parseCPAMCPreferences(
      JSON.stringify({ state: { theme: 'light' } }),
      JSON.stringify({ state: { language: 'zh-CN' } }),
    )).toEqual({ theme: 'white', language: 'zh' });
    expect(parseCPAMCPreferences(
      JSON.stringify({ state: { theme: 'dark' } }),
      JSON.stringify({ state: { language: 'zh-TW' } }),
    )).toEqual({ theme: 'dark', language: 'zh-TW' });
  });

  it('asks the parent management page to open provider configuration', () => {
    const messages: unknown[] = [];
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      parent: { postMessage: (message: unknown) => messages.push(message) },
    });

    openCPAMCAIProviders('?embed=cpamc');
    expect(messages).toEqual([{ type: 'cpa-usage-keeper:navigate', route: '#/ai-providers' }]);
  });
});
