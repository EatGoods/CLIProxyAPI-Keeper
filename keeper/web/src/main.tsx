import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import i18n from './i18n';
import faviconUrl from './assets/keeper-icon.svg';
import './styles/reset.scss';
import './styles/variables.scss';
import './styles/themes.scss';
import './styles/layout.scss';
import './styles/components.scss';
import './styles/global.scss';
import { useThemeStore } from './stores';
import { subscribeCPAMCPreferences } from './embed/cpamcEmbed';

const faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
faviconEl.rel = 'icon';
faviconEl.type = 'image/svg+xml';
faviconEl.href = faviconUrl;
if (!faviconEl.parentNode) {
  document.head.appendChild(faviconEl);
}

function Root() {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  const setTheme = useThemeStore((state) => state.setTheme);

  useEffect(() => {
    const stopTheme = initializeTheme();
    const stopPreferences = subscribeCPAMCPreferences(({ theme, language }) => {
      if (theme) setTheme(theme);
      if (language && i18n.language !== language) void i18n.changeLanguage(language);
    });
    return () => {
      stopPreferences();
      stopTheme();
    };
  }, [initializeTheme, setTheme]);

  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <Root />
    </I18nextProvider>
  </StrictMode>
);
