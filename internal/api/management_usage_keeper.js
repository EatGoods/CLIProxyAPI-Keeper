(() => {
  const route = '#/usage';
  const basePath = String(window.__CPA_USAGE_KEEPER_BASE_PATH__ || '/usage').replace(/\/$/, '');
  const sessionEndpoint = '/v0/management/usage-keeper/session';
  const providerNoteEndpoint = '/v0/management/provider-note';
  const sessionStorageKey = 'cpa_usage_keeper_embed_session';
  const providerPaths = new Set([
    'gemini-api-key', 'interactions-api-key', 'claude-api-key', 'codex-api-key',
    'xai-api-key', 'vertex-api-key', 'openai-compatibility',
  ]);
  const providerRecords = new Map();
  const cpaAPIKeyRecords = [];
  let pendingInitialUsage = window.location.hash === route;
  let usageVisible = false;
  let managementCredential;
  let keeperSessionToken = '';
  let sessionExchange;
  let panel;
  let frame;
  let main;
  let previousMainVisibility = '';
  let previousRootOverflow = '';
  let resizeObserver;

  const activateFrameSession = () => {
    if (!frame || !keeperSessionToken) return;
    try {
      const storage = frame.contentWindow.sessionStorage;
      if (storage.getItem(sessionStorageKey) !== keeperSessionToken) {
        storage.setItem(sessionStorageKey, keeperSessionToken);
        frame.contentWindow.location.reload();
        return;
      }
    } catch {
      // Same-origin sessionStorage is preferred; Keeper still supports its secure cookie fallback.
    }
    frame.hidden = false;
  };

  const exchangeKeeperSession = () => {
    if (!managementCredential || keeperSessionToken) {
      activateFrameSession();
      return sessionExchange;
    }
    if (sessionExchange) return sessionExchange;
    sessionExchange = fetch(sessionEndpoint, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        [managementCredential.name]: managementCredential.value,
        'X-CPA-Usage-Keeper-Request': 'fetch',
      },
    }).then((response) => {
      if (!response.ok) throw new Error(`Keeper session exchange failed: ${response.status}`);
      return response.json();
    }).then((payload) => {
      keeperSessionToken = String(payload.session_token || '');
      activateFrameSession();
      void loadCPAAPIKeys();
    }).catch(() => {
      keeperSessionToken = '';
    }).finally(() => {
      sessionExchange = undefined;
    });
    return sessionExchange;
  };

  const rememberManagementCredential = (name, value) => {
    const next = { name, value: String(value) };
    if (managementCredential?.name === next.name && managementCredential.value === next.value) return;
    managementCredential = next;
    keeperSessionToken = '';
    cpaAPIKeyRecords.length = 0;
    sessionExchange = undefined;
    void exchangeKeeperSession();
  };

  const managementCredentialFromHeaders = (headers) => {
    const authorization = headers.get('Authorization');
    if (authorization) return ['Authorization', authorization];
    const managementKey = headers.get('X-Management-Key');
    return managementKey ? ['X-Management-Key', managementKey] : undefined;
  };

  const providerPath = (url) => {
    try {
      const path = new URL(url, location.href).pathname.split('/').pop();
      return providerPaths.has(path) ? path : undefined;
    } catch {
      return undefined;
    }
  };

  const rememberProviderPayload = (url, payload) => {
    const provider = providerPath(url);
    const entries = provider && payload?.[provider];
    if (!provider || !Array.isArray(entries)) return;
    const records = [];
    entries.forEach((entry, index) => {
      const configIndex = Number.isInteger(entry['config-index']) ? entry['config-index'] : index;
      if (provider !== 'openai-compatibility') {
        records.push({
          provider,
          configIndex,
          apiKey: String(entry['api-key'] || ''),
          baseURL: String(entry['base-url'] || ''),
          note: String(entry.note || ''),
        });
        return;
      }
      const keys = Array.isArray(entry['api-key-entries']) ? entry['api-key-entries'] : [];
      if (keys.length === 0) {
        records.push({ provider, configIndex, apiKey: '', baseURL: String(entry['base-url'] || ''), note: String(entry.note || '') });
        return;
      }
      keys.forEach((key, keyIndex) => records.push({
        provider,
        configIndex,
        keyIndex: Number.isInteger(key['config-index']) ? key['config-index'] : keyIndex,
        apiKey: String(key['api-key'] || ''),
        baseURL: String(entry['base-url'] || ''),
        note: String(key.note || entry.note || ''),
      }));
    });
    providerRecords.set(provider, records);
    queueMicrotask(ensureProviderNotes);
  };

  const rememberManagementPayload = (url, payload) => {
    if (providerPath(url)) {
      rememberProviderPayload(url, payload);
      return;
    }
    let path;
    try { path = new URL(url, location.href).pathname; } catch { return; }
    if (!path.endsWith('/v0/management/config')) return;
    providerPaths.forEach((provider) => {
      if (Array.isArray(payload?.[provider])) rememberProviderPayload(`/v0/management/${provider}`, payload);
    });
  };

  const nativeFetch = window.fetch.bind(window);
  let apiKeySettingsRequest;
  const loadCPAAPIKeys = () => {
    if (!keeperSessionToken || apiKeySettingsRequest) return apiKeySettingsRequest;
    apiKeySettingsRequest = nativeFetch(`${basePath}/api/v1/usage/api-keys/settings`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'X-CPA-Usage-Keeper-Embed': 'cpamc',
        'X-CPA-Usage-Keeper-Embed-Session': keeperSessionToken,
        'X-CPA-Usage-Keeper-Request': 'fetch',
      },
    }).then((response) => {
      if (!response.ok) throw new Error(`Could not load API key aliases: ${response.status}`);
      return response.json();
    }).then((payload) => {
      cpaAPIKeyRecords.splice(0, cpaAPIKeyRecords.length, ...(Array.isArray(payload.items) ? payload.items : []));
      queueMicrotask(ensureCPAAPIKeyAliases);
    }).catch(() => {
      cpaAPIKeyRecords.length = 0;
    }).finally(() => {
      apiKeySettingsRequest = undefined;
    });
    return apiKeySettingsRequest;
  };

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (response.ok && url.includes('/v0/management/')) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      const credential = managementCredentialFromHeaders(headers);
      if (credential) rememberManagementCredential(...credential);
    }
    if (response.ok && url.includes('/v0/management/')) {
      void response.clone().json().then((payload) => rememberManagementPayload(url, payload)).catch(() => {});
    }
    return response;
  };

  const xhrMetadata = new WeakMap();
  const nativeXHROpen = XMLHttpRequest.prototype.open;
  const nativeXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrMetadata.set(this, { method: String(method).toUpperCase(), url: String(url) });
    return nativeXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const metadata = xhrMetadata.get(this) || {};
    if (/^(authorization|x-management-key)$/i.test(name)) metadata.credential = [name, value];
    xhrMetadata.set(this, metadata);
    return nativeXHRSetRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const metadata = xhrMetadata.get(this);
    if (metadata?.url.includes('/v0/management/') && metadata.credential) {
      this.addEventListener('load', () => {
        if (this.status < 200 || this.status >= 300) return;
        rememberManagementCredential(...metadata.credential);
        if (metadata.method === 'GET') {
          try { rememberManagementPayload(metadata.url, JSON.parse(this.responseText)); } catch { /* Ignore non-JSON responses. */ }
        }
      }, { once: true });
    }
    return nativeXHRSend.call(this, body);
  };

  if (pendingInitialUsage) {
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  }

  const usageLabel = () => {
    const quota = document.querySelector('aside a[href="#/quota"] .nav-label')?.textContent || '';
    if (/quota/i.test(quota)) return 'Usage';
    return quota.includes('額') ? '用量統計' : '用量统计';
  };

  const setNavActive = (active) => {
    const usageLink = document.querySelector('aside a[data-cpa-usage-keeper-nav]');
    if (!usageLink) return;
    if (active) {
      document.querySelectorAll('aside a.nav-item.active').forEach((link) => {
        if (link !== usageLink) {
          link.classList.remove('active');
          link.removeAttribute('aria-current');
        }
      });
      usageLink.classList.add('active');
      usageLink.setAttribute('aria-current', 'page');
      return;
    }
    usageLink.classList.remove('active');
    usageLink.removeAttribute('aria-current');
  };

  const ensureNav = () => {
    const quotaLink = document.querySelector('aside a[href="#/quota"]');
    if (!quotaLink) return;
    let usageLink = document.querySelector('aside a[data-cpa-usage-keeper-nav]');
    if (!usageLink) {
      usageLink = quotaLink.cloneNode(true);
      usageLink.dataset.cpaUsageKeeperNav = '';
      usageLink.href = route;
      usageLink.removeAttribute('data-discover');
      usageLink.querySelector('.nav-badge-sr-only')?.remove();
      quotaLink.insertAdjacentElement('afterend', usageLink);
    }
    const nextLabel = usageLabel();
    const label = usageLink.querySelector('.nav-label');
    if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
    usageLink.title = nextLabel;
    setNavActive(location.hash === route);
  };

  const updateBounds = () => {
    if (!panel || !main?.isConnected) return;
    const bounds = main.getBoundingClientRect();
    const headerBottom = document.querySelector('header.main-header')?.getBoundingClientRect().bottom || 0;
    const top = Math.max(0, bounds.top, headerBottom);
    const left = Math.max(0, bounds.left);
    Object.assign(panel.style, {
      top: `${top}px`,
      left: `${left}px`,
      width: `${Math.max(0, Math.min(innerWidth, bounds.right) - left)}px`,
      height: `${Math.max(0, innerHeight - top)}px`,
    });
  };

  const ensurePanel = () => {
    const nextMain = document.querySelector('main.main-content');
    if (!nextMain) return false;
    if (main !== nextMain) {
      resizeObserver?.disconnect();
      main = nextMain;
      resizeObserver = new ResizeObserver(updateBounds);
      resizeObserver.observe(main);
    }
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'cpa-usage-keeper-panel';
      panel.setAttribute('aria-label', usageLabel());
      Object.assign(panel.style, {
        position: 'fixed',
        zIndex: '20',
        overflow: 'hidden',
        background: 'var(--bg-primary, #f6f7f9)',
      });
      frame = document.createElement('iframe');
      frame.src = `${basePath}/?embed=cpamc`;
      frame.title = usageLabel();
      frame.hidden = true;
      frame.addEventListener('load', activateFrameSession);
      Object.assign(frame.style, {
        display: 'block',
        width: '100%',
        height: '100%',
        border: '0',
        background: 'transparent',
      });
      panel.append(frame);
      document.body.append(panel);
      void exchangeKeeperSession();
    }
    return true;
  };

  const showUsage = (pushHistory) => {
    ensureNav();
    if (!ensurePanel()) {
      if (panel) panel.hidden = true;
      return;
    }
    if (pushHistory && location.hash !== route) history.pushState(null, '', route);
    if (!usageVisible) {
      previousMainVisibility = main.style.visibility;
      previousRootOverflow = document.documentElement.style.overflow;
    }
    usageVisible = true;
    main.style.visibility = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    panel.hidden = false;
    void exchangeKeeperSession();
    setNavActive(true);
    updateBounds();
    requestAnimationFrame(updateBounds);
    if (pendingInitialUsage) {
      pendingInitialUsage = false;
      history.replaceState(null, '', route);
    }
  };

  const hideUsage = () => {
    if (panel) panel.hidden = true;
    if (usageVisible && main?.isConnected) main.style.visibility = previousMainVisibility;
    if (usageVisible) document.documentElement.style.overflow = previousRootOverflow;
    usageVisible = false;
    setNavActive(false);
  };

  const noteLabels = () => {
    const keyHeader = document.querySelector('main table th')?.textContent || '';
    if (/key/i.test(keyHeader)) return { header: 'Note', add: 'Add note', edit: 'Edit note', prompt: 'Note (up to 200 characters)' };
    if (keyHeader.includes('鑰') || keyHeader.includes('金')) return { header: '備註', add: '新增備註', edit: '編輯備註', prompt: '備註（最多 200 個字）' };
    return { header: '备注', add: '添加备注', edit: '编辑备注', prompt: '备注（最多 200 个字）' };
  };

  const maskedKey = (key) => key ? `${key.slice(0, 2)}******${key.slice(-2)}` : '';
  const findCPAAPIKeyRecord = (row) => {
    const existingID = row.dataset.cpaApiKeyId;
    const existing = existingID && cpaAPIKeyRecords.find((item) => String(item.id) === existingID);
    if (existing) return existing;
    const displayKey = row.querySelector('.item-subtitle')?.textContent?.trim() || '';
    const record = cpaAPIKeyRecords.find((item) => item.displayKey === displayKey || maskedKey(item.apiKey) === displayKey);
    if (record) row.dataset.cpaApiKeyId = String(record.id);
    return record;
  };

  const saveCPAAPIKeyAlias = async (record, keyAlias) => {
    const response = await nativeFetch(`${basePath}/api/v1/usage/api-keys/${encodeURIComponent(record.id)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-CPA-Usage-Keeper-Embed': 'cpamc',
        'X-CPA-Usage-Keeper-Embed-Session': keeperSessionToken,
        'X-CPA-Usage-Keeper-Request': 'fetch',
      },
      body: JSON.stringify({ keyAlias }),
    });
    if (!response.ok) throw new Error(`Could not save API key alias: ${response.status}`);
    Object.assign(record, await response.json());
  };

  const editCPAAPIKeyAlias = (pill) => {
    const record = cpaAPIKeyRecords.find((item) => String(item.id) === pill.closest('.item-row')?.dataset.cpaApiKeyId);
    if (!record || pill.dataset.saving === 'true' || pill.dataset.editing === 'true') return;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 128;
    input.value = record.keyAlias || '';
    input.className = 'cpa-api-key-alias-input';
    input.setAttribute('aria-label', noteLabels().header);
    pill.dataset.editing = 'true';
    pill.replaceChildren(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      if (save) {
        const keyAlias = input.value.trim();
        if ([...keyAlias].length > 128 || /[\r\n]/.test(keyAlias)) {
          finished = false;
          window.alert(noteLabels().prompt.replace('200', '128'));
          input.focus();
          return;
        }
        pill.dataset.saving = 'true';
        try {
          await saveCPAAPIKeyAlias(record, keyAlias);
          frame?.contentWindow.location.reload();
        } catch (error) {
          finished = false;
          window.alert(error instanceof Error ? error.message : String(error));
          input.focus();
          return;
        } finally {
          pill.dataset.saving = 'false';
        }
      }
      pill.dataset.editing = 'false';
      ensureCPAAPIKeyAliases();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener('blur', () => void finish(true));
  };

  function ensureCPAAPIKeyAliases() {
    document.querySelectorAll('main .item-row').forEach((row) => {
      const record = findCPAAPIKeyRecord(row);
      const pill = record && row.querySelector('.item-meta > .pill');
      if (!pill) return;
      if (!pill.dataset.cpaApiKeyFallback) pill.dataset.cpaApiKeyFallback = pill.textContent?.trim() || '';
      pill.dataset.cpaApiKeyAlias = '';
      pill.title = noteLabels().edit;
      if (!pill.dataset.cpaApiKeyAliasBound) {
        pill.dataset.cpaApiKeyAliasBound = 'true';
        pill.addEventListener('dblclick', () => editCPAAPIKeyAlias(pill));
      }
      if (pill.dataset.editing === 'true') return;
      const label = record.keyAlias || pill.dataset.cpaApiKeyFallback;
      if (pill.textContent !== label) pill.textContent = label;
    });
  }

  const normalizedURL = (value) => String(value || '').trim().replace(/\/$/, '');
  const findProviderRecord = (row) => {
    const key = row.cells[0]?.textContent?.trim() || '';
    const baseURL = normalizedURL(row.cells[1]?.textContent);
    for (const records of providerRecords.values()) {
      const record = records.find((item) => (
        (!item.apiKey || maskedKey(item.apiKey) === key) && normalizedURL(item.baseURL) === baseURL
      ));
      if (record) return record;
    }
    return undefined;
  };

  const saveProviderNote = async (record, note) => {
    if (!managementCredential) throw new Error('Management credential is unavailable');
    const response = await nativeFetch(providerNoteEndpoint, {
      method: 'PATCH',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        [managementCredential.name]: managementCredential.value,
      },
      body: JSON.stringify({
        provider: record.provider,
        'config-index': record.configIndex,
        ...(record.keyIndex === undefined ? {} : { 'key-index': record.keyIndex }),
        note,
      }),
    });
    if (!response.ok) throw new Error(`Could not save note: ${response.status}`);
    record.note = note;
  };

  function ensureProviderNotes() {
    if (location.hash !== '#/ai-providers') return;
    const table = document.querySelector('main table');
    const headerRow = table?.tHead?.rows[0];
    if (!table || !headerRow) return;
    const labels = noteLabels();
    let header = headerRow.querySelector('[data-cpa-provider-note-header]');
    if (!header) {
      header = document.createElement('th');
      header.dataset.cpaProviderNoteHeader = '';
      headerRow.insertBefore(header, headerRow.lastElementChild);
    }
    if (header.textContent !== labels.header) header.textContent = labels.header;

    [...table.tBodies].flatMap((body) => [...body.rows]).forEach((row) => {
      const record = findProviderRecord(row);
      let cell = row.querySelector('[data-cpa-provider-note-cell]');
      if (!cell) {
        cell = document.createElement('td');
        cell.dataset.cpaProviderNoteCell = '';
        row.insertBefore(cell, row.lastElementChild);
      }
      if (!record) {
        if (cell.childNodes.length > 0) cell.replaceChildren();
        return;
      }
      const recordID = `${record.provider}:${record.configIndex}:${record.keyIndex ?? ''}`;
      let button = cell.querySelector('.cpa-provider-note-button');
      if (!button || button.dataset.recordId !== recordID) {
        cell.replaceChildren();
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'cpa-provider-note-button';
        button.dataset.recordId = recordID;
        button.addEventListener('click', async () => {
          const next = window.prompt(noteLabels().prompt, record.note || '');
          if (next === null) return;
          const note = next.trim();
          if ([...note].length > 200 || /[\r\n]/.test(note)) {
            window.alert(noteLabels().prompt);
            return;
          }
          button.disabled = true;
          try {
            await saveProviderNote(record, note);
            ensureProviderNotes();
          } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
            button.disabled = false;
          }
        });
        cell.append(button);
      }
      const text = record.note || labels.add;
      if (button.textContent !== text) button.textContent = text;
      button.dataset.empty = record.note ? 'false' : 'true';
      button.title = record.note ? labels.edit : labels.add;
      button.disabled = false;
    });
  }

  const ensureProviderNoteStyles = () => {
    if (document.querySelector('#cpa-provider-note-styles')) return;
    const style = document.createElement('style');
    style.id = 'cpa-provider-note-styles';
    style.textContent = `
      [data-cpa-provider-note-header], [data-cpa-provider-note-cell] { min-width: 150px; max-width: 230px; }
      .cpa-provider-note-button { display:block; width:100%; overflow:hidden; padding:7px 9px; border:1px solid var(--border-color); border-radius:8px; color:var(--text-primary); background:var(--bg-secondary); font:inherit; font-size:12px; text-align:left; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
      .cpa-provider-note-button[data-empty="true"] { color:var(--text-tertiary); border-style:dashed; }
      .cpa-provider-note-button:hover { border-color:var(--primary-color); }
      .cpa-provider-note-button:disabled { opacity:.6; cursor:wait; }
      [data-cpa-api-key-alias] { cursor:text; }
      [data-cpa-api-key-alias][data-saving="true"] { opacity:.6; cursor:wait; }
      .cpa-api-key-alias-input { width:100%; min-width:100px; padding:0; border:0; outline:0; color:inherit; background:transparent; font:inherit; }
    `;
    document.head.append(style);
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('aside a');
    if (!link) return;
    if (link.matches('[data-cpa-usage-keeper-nav]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showUsage(true);
      return;
    }
    hideUsage();
  }, true);

  window.addEventListener('popstate', (event) => {
    if (location.hash === route) {
      event.stopImmediatePropagation();
      showUsage(false);
      return;
    }
    hideUsage();
  }, true);

  window.addEventListener('resize', updateBounds);
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type !== 'cpa-usage-keeper:navigate' || event.data.route !== '#/ai-providers') return;
    hideUsage();
    location.hash = '#/ai-providers';
  });

  const sync = () => {
    ensureNav();
    ensureProviderNoteStyles();
    ensureProviderNotes();
    ensureCPAAPIKeyAliases();
    if (location.hash === route || pendingInitialUsage) showUsage(false);
  };
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', sync) : sync();
})();
