/**
 * Multi-Provider Ad-Free Twitch Proxy Manager
 * Integrates Luminous (TTV LOL PRO) and ReYohoho proxies for 100% ad-free 1440p/1080p playback
 */

import { getStoredToken } from './twitch_auth';

export const PROXY_PROVIDERS = [
  { id: 'proxy4', name: 'ReYohoho Server 4 (Россия - 1440p)', type: 'usher', url: 'https://proxy4.rte.net.ru/' },
  { id: 'proxy7', name: 'ReYohoho Server 7 (1440p)', type: 'usher', url: 'https://proxy7.rte.net.ru/' },
  { id: 'proxy5', name: 'ReYohoho Server 5 (1440p)', type: 'usher', url: 'https://proxy5.rte.net.ru/' },
  { id: 'proxy6', name: 'ReYohoho Server 6 (1440p)', type: 'usher', url: 'https://proxy6.rte.net.ru/' },
  { id: 'luminous_eu', name: 'Luminous EU (Ad-Free PRO)', type: 'direct', url: 'https://eu.luminous.dev/playlist/{channel}?allow_source=true&allow_audio_only=true&fast_bread=true&low_latency=true' },
  { id: 'luminous_eu2', name: 'Luminous EU 2', type: 'direct', url: 'https://eu2.luminous.dev/playlist/{channel}?allow_source=true&allow_audio_only=true&fast_bread=true&low_latency=true' }
];

export const REYOHOHO_SERVERS = PROXY_PROVIDERS.filter(p => p.type === 'usher');

const STORAGE_KEY_PROXY = 'twitch_native_proxy_server';

export function getCurrentProxyServer() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PROXY);
    // If previously saved to Luminous or direct (has ads) or outdated url, auto-migrate to proxy4
    if (saved && (saved.includes('luminous.dev') || saved.includes('usher.ttvnw.net') || !PROXY_PROVIDERS.some(s => s.url === saved))) {
      localStorage.setItem(STORAGE_KEY_PROXY, PROXY_PROVIDERS[0].url);
      return PROXY_PROVIDERS[0].url;
    }
    if (saved && PROXY_PROVIDERS.some(s => s.url === saved)) {
      return saved;
    }
  } catch (e) {
    // fallback
  }
  return PROXY_PROVIDERS[0].url;
}

export function setCurrentProxyServer(url) {
  try {
    localStorage.setItem(STORAGE_KEY_PROXY, url);
  } catch (e) {
    console.error('Failed to set proxy server:', e);
  }
}

/**
 * Ping / health check for proxy server
 */
export async function testProxyPing(serverUrl) {
  const checkUrl = serverUrl.includes('{channel}')
    ? serverUrl.replace('{channel}', 'lofigirl')
    : `${serverUrl}https://usher.ttvnw.net/api/channel/hls/lofigirl.m3u8?allow_source=true&allow_audio_only=true&fast_bread=true`;

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(checkUrl, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;
    return {
      ok: res.ok,
      status: res.status,
      ms: latency
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: 0,
      ms: 0,
      error: err.name === 'AbortError' ? 'Таймаут' : 'Ошибка сети'
    };
  }
}

/**
 * Fetch live M3U8 master playlist through Ad-Free proxy with automatic multi-server failover
 */
export async function fetchLiveManifest(channelLogin, sig, token) {
  const current = getCurrentProxyServer();
  const serversToTry = [
    current,
    ...PROXY_PROVIDERS.map(s => s.url).filter(u => u !== current)
  ];

  let lastError = null;

  for (const server of serversToTry) {
    try {
      let fullUrl = '';
      if (server.includes('{channel}')) {
        fullUrl = server.replace('{channel}', encodeURIComponent(channelLogin));
      } else {
        const usherParams = new URLSearchParams({
          sig,
          token,
          allow_source: 'true',
          fast_bread: 'true',
          low_latency: 'true',
          supported_codecs: 'h265,h264'
        });
        // Never append user auth token: user auth triggers Twitch SSAI ad breaks on non-Turbo accounts
        fullUrl = `${server}https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channelLogin)}.m3u8?${usherParams.toString()}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);

      const res = await fetch(fullUrl, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const text = await res.text();
        if (text && text.includes('#EXTM3U')) {
          return {
            manifest: text,
            serverUrl: server
          };
        }
      }
      lastError = new Error(`Proxy ${server} returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      console.warn(`[Proxy] Server ${server} failed, trying next:`, err.message);
    }
  }

  throw lastError || new Error('Все серверы AdBlock прокси недоступны в данный момент.');
}
