/**
 * ReYohoho Twitch Proxy Manager
 * Handles ad-free stream playlist retrieval and server failover.
 */

export const REYOHOHO_SERVERS = [
  { id: 'proxy4', name: 'ReYohoho Server 4 (Рекомендуемый)', url: 'https://proxy4.rte.net.ru/' },
  { id: 'proxy7', name: 'ReYohoho Server 7', url: 'https://proxy7.rte.net.ru/' },
  { id: 'proxy5', name: 'ReYohoho Server 5', url: 'https://proxy5.rte.net.ru/' },
  { id: 'proxy6', name: 'ReYohoho Server 6', url: 'https://proxy6.rte.net.ru/' }
];

const STORAGE_KEY_PROXY = 'twitch_native_proxy_server';

export function getCurrentProxyServer() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PROXY);
    if (saved && REYOHOHO_SERVERS.some(s => s.url === saved)) {
      return saved;
    }
  } catch (e) {
    // fallback
  }
  return REYOHOHO_SERVERS[0].url;
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
  const checkUrl = `${serverUrl}https://usher.ttvnw.net/api/channel/hls/lofigirl.m3u8?allow_source=true&allow_audio_only=true&fast_bread=true`;
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(checkUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
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
 * Fetch live M3U8 master playlist through ReYohoho proxy with automatic failover
 */
export async function fetchLiveManifest(channelLogin, sig, token) {
  const current = getCurrentProxyServer();
  const serversToTry = [
    current,
    ...REYOHOHO_SERVERS.map(s => s.url).filter(u => u !== current)
  ];

  let lastError = null;

  for (const server of serversToTry) {
    try {
      const usherParams = new URLSearchParams({
        sig,
        token,
        allow_source: 'true',
        fast_bread: 'true',
        supported_codecs: 'h265,h264'
      });

      const fullUrl = `${server}https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channelLogin)}.m3u8?${usherParams.toString()}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0'
        },
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
      lastError = new Error(`Server ${server} returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      console.warn(`[Proxy] Server ${server} failed, trying next:`, err.message);
    }
  }

  throw lastError || new Error('Все серверы ReYohoho недоступны в данный момент.');
}
