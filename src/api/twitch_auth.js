/**
 * Twitch TV OAuth Device Code Flow
 * Enables easy TV login by visiting twitch.tv/activate and entering a short code.
 */

import { fetchCurrentUser } from './twitch_gql';

const TV_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';
const DEVICE_ENDPOINT = 'https://id.twitch.tv/oauth2/device';
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';

const STORAGE_KEY_TOKEN = 'twitch_native_token';
const STORAGE_KEY_USER = 'twitch_native_user';

let currentPollTimer = null;

export function getStoredToken() {
  try {
    return localStorage.getItem(STORAGE_KEY_TOKEN) || null;
  } catch (e) {
    return null;
  }
}

export function saveToken(token) {
  try {
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
  } catch (e) {
    console.error('Failed to save token to localStorage:', e);
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_USER);
  } catch (e) {
    console.error('Failed to clear token:', e);
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function saveUser(user) {
  try {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  } catch (e) {
    console.error('Failed to save user:', e);
  }
}

/**
 * Request device authorization code
 */
export async function requestDeviceCode() {
  const params = new URLSearchParams();
  params.append('client_id', TV_CLIENT_ID);
  params.append('scopes', 'user:read:follows');

  const res = await fetch(DEVICE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Device code request failed: ${res.status}`);
  }

  return await res.json();
}

/**
 * Stop active polling
 */
export function stopPolling() {
  if (currentPollTimer) {
    clearTimeout(currentPollTimer);
    currentPollTimer = null;
  }
}

/**
 * Start the TV login flow
 */
export async function startDeviceFlow(onCodeReceived, onAuthenticated, onError) {
  stopPolling();

  try {
    const data = await requestDeviceCode();
    const { device_code, user_code, verification_uri, expires_in, interval } = data;

    if (onCodeReceived) {
      onCodeReceived({
        userCode: user_code,
        verificationUri: verification_uri || 'https://www.twitch.tv/activate'
      });
    }

    const pollInterval = (interval || 5) * 1000;
    const expiresAt = Date.now() + (expires_in || 1800) * 1000;

    const poll = async () => {
      if (Date.now() >= expiresAt) {
        if (onError) onError(new Error('Срок действия кода истек. Попробуйте снова.'));
        return;
      }

      try {
        const body = new URLSearchParams();
        body.append('client_id', TV_CLIENT_ID);
        body.append('device_code', device_code);
        body.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

        const tokenRes = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: body.toString()
        });

        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          const accessToken = tokenData.access_token;
          if (accessToken) {
            saveToken(accessToken);
            // Fetch profile
            const profile = await fetchCurrentUser(accessToken);
            if (profile) {
              saveUser(profile);
            }
            if (onAuthenticated) {
              onAuthenticated(profile || { login: 'user' });
            }
            return;
          }
        } else {
          const errData = await tokenRes.json().catch(() => ({}));
          if (errData.message === 'authorization_pending') {
            // User hasn't entered code yet, keep polling
            currentPollTimer = setTimeout(poll, pollInterval);
            return;
          } else if (errData.message === 'slow_down') {
            currentPollTimer = setTimeout(poll, pollInterval + 5000);
            return;
          } else {
            console.log('[Auth] Polling status:', errData.message);
            currentPollTimer = setTimeout(poll, pollInterval);
            return;
          }
        }
      } catch (err) {
        console.warn('[Auth] Polling error:', err);
        currentPollTimer = setTimeout(poll, pollInterval);
      }
    };

    currentPollTimer = setTimeout(poll, pollInterval);
  } catch (err) {
    if (onError) onError(err);
  }
}
