/**
 * Multi-Provider Ad-Free Twitch Proxy Manager
 * Integrates Luminous (TTV LOL PRO) and ReYohoho proxies for 100% ad-free 1440p/1080p playback
 */

import { getStoredToken } from './twitch_auth';

export const PROXY_PROVIDERS = [
  { id: 'luminous_eu', name: 'Luminous EU (Ad-Free PRO)', type: 'direct', url: 'https://eu.luminous.dev/playlist/{channel}?allow_source=true&allow_audio_only=true&fast_bread=true&low_latency=true' },
  { id: 'luminous_eu2', name: 'Luminous EU 2', type: 'direct', url: 'https://eu2.luminous.dev/playlist/{channel}?allow_source=true&allow_audio_only=true&fast_bread=true&low_latency=true' },
  { id: 'proxy4', name: 'ReYohoho Server 4 (Россия)', type: 'usher', url: 'https://proxy4.rte.net.ru/' },
  { id: 'proxy7', name: 'ReYohoho Server 7', type: 'usher', url: 'https://proxy7.rte.net.ru/' },
  { id: 'proxy5', name: 'ReYohoho Server 5', type: 'usher', url: 'https://proxy5.rte.net.ru/' },
  { id: 'proxy6', name: 'ReYohoho Server 6', type: 'usher', url: 'https://proxy6.rte.net.ru/' }
];

export const REYOHOHO_SERVERS = PROXY_PROVIDERS.filter(p => p.type === 'usher');

const STORAGE_KEY_PROXY = 'twitch_native_proxy_server';

export function getCurrentProxyServer() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PROXY);
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
  const userAuthToken = getStoredToken();

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
        if (userAuthToken) {
          usherParams.set('auth', userAuthToken);
        }
        fullUrl = `${server}https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channelLogin)}.m3u8?${usherParams.toString()}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

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
