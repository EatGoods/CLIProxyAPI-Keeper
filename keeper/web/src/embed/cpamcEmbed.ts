const CPAMC_EMBED_QUERY_VALUE = 'cpamc';
const CPAMC_READY_MESSAGE = 'cpa-usage-keeper:ready';
const CPAMC_NAVIGATE_MESSAGE = 'cpa-usage-keeper:navigate';
const CPAMC_THEME_STORAGE_KEY = 'cli-proxy-theme';
const CPAMC_LANGUAGE_STORAGE_KEY = 'cli-proxy-language';

export interface CPAMCPreferences {
  theme?: 'white' | 'dark' | 'auto';
  language?: 'en' | 'zh' | 'zh-TW';
}

const currentSearch = () => (typeof window === 'undefined' ? '' : window.location?.search ?? '');

const hasCPAMCEmbedValue = (params: URLSearchParams, name: string) => (
  params.getAll(name).includes(CPAMC_EMBED_QUERY_VALUE)
);

export const isCPAMCEmbed = (search = currentSearch()): boolean => {
  const params = new URLSearchParams(search);
  return hasCPAMCEmbedValue(params, 'embed') || hasCPAMCEmbedValue(params, 'mode');
};

export const cpamcEmbedSearch = (search = currentSearch()): '' | '?embed=cpamc' => (
  isCPAMCEmbed(search) ? '?embed=cpamc' : ''
);

export const notifyCPAMCEmbedReady = (search = currentSearch()): void => {
  if (!isCPAMCEmbed(search) || typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ type: CPAMC_READY_MESSAGE }, window.location.origin);
};

const persistedValue = (raw: string | null, name: string): unknown => {
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as { state?: Record<string, unknown> }).state?.[name];
  } catch {
    return undefined;
  }
};

export const parseCPAMCPreferences = (themeRaw: string | null, languageRaw: string | null): CPAMCPreferences => {
  const themeValue = persistedValue(themeRaw, 'theme');
  const languageValue = persistedValue(languageRaw, 'language');
  const preferences: CPAMCPreferences = {};

  if (themeValue === 'dark' || themeValue === 'auto') preferences.theme = themeValue;
  if (themeValue === 'light' || themeValue === 'white') preferences.theme = 'white';
  if (typeof languageValue === 'string') {
    if (/^zh-(tw|hk)|hant/i.test(languageValue)) preferences.language = 'zh-TW';
    else if (/^zh/i.test(languageValue)) preferences.language = 'zh';
    else if (/^en/i.test(languageValue)) preferences.language = 'en';
  }
  return preferences;
};

export const subscribeCPAMCPreferences = (
  listener: (preferences: CPAMCPreferences) => void,
  search = currentSearch(),
): (() => void) => {
  if (!isCPAMCEmbed(search) || typeof window === 'undefined') return () => {};
  const notify = () => listener(parseCPAMCPreferences(
    window.localStorage.getItem(CPAMC_THEME_STORAGE_KEY),
    window.localStorage.getItem(CPAMC_LANGUAGE_STORAGE_KEY),
  ));
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CPAMC_THEME_STORAGE_KEY || event.key === CPAMC_LANGUAGE_STORAGE_KEY) notify();
  };
  notify();
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
};

export const openCPAMCAIProviders = (search = currentSearch()): void => {
  if (!isCPAMCEmbed(search) || typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ type: CPAMC_NAVIGATE_MESSAGE, route: '#/ai-providers' }, window.location.origin);
};
