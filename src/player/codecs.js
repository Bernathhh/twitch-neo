/**
 * Video Codec Normalizer & Hardware Pipeline Patcher for LG webOS TV
 *
 * Provides:
 * 1. Global MSE hooks: MediaSource.isTypeSupported, ManagedMediaSource.isTypeSupported,
 *    and MediaSource.prototype.addSourceBuffer fallback chain.
 * 2. Complete removal of AV1 (av01 / av1) streams to prevent software decoding OOM.
 * 3. Normalization of Twitch HEVC (hev1.1.6.L150.90.0.0.0.0.0) -> hvc1.1.6.L150.B0 / hvc1.1.6.L93.B0.
 * 4. Clamping of high-profile AVC Level 5.x -> Level 4.2 (avc1.64002a).
 */

export function isAv1Codec(type) {
  if (typeof type !== 'string') return false;
  const lower = type.toLowerCase();
  return lower.includes('av01') || (lower.includes('av1') && !lower.includes('avc1'));
}

export function isHevcCodec(type) {
  if (typeof type !== 'string') return false;
  const lower = type.toLowerCase();
  return lower.includes('hev1') || lower.includes('hvc1');
}

export function cleanHevcCodec(type) {
  if (typeof type !== 'string') return type;
  return type.replace(
    /(hev1|hvc1)\.([1-9]\d*)\.([\da-fA-F]+)\.([LH]\d+)\.([\da-fA-F]+)(?:\.[\da-fA-F]+)+/g,
    '$1.$2.$3.$4.$5'
  );
}

export function checkHevcSupported(origFn, context, type) {
  if (typeof origFn !== 'function') return false;
  try {
    if (origFn.call(context, type)) return true;
    if (typeof type === 'string') {
      const cleaned = cleanHevcCodec(type);
      if (cleaned !== type && origFn.call(context, cleaned)) return true;

      const swapped = cleaned.includes('hev1')
        ? cleaned.replace(/hev1/g, 'hvc1')
        : cleaned.replace(/hvc1/g, 'hev1');
      if (origFn.call(context, swapped)) return true;

      // Universal baseline L93.B0 supported across webOS Starfish GStreamer
      const l93 = swapped.replace(/(hvc1|hev1)(?:\.[^",]+)?/g, 'hvc1.1.6.L93.B0');
      if (origFn.call(context, l93)) return true;

      if (origFn.call(context, 'video/mp4; codecs="hvc1.1.6.L93.B0"')) return true;
      if (origFn.call(context, 'video/mp4; codecs="hvc1"')) return true;
      if (origFn.call(context, 'video/mp4; codecs="hev1"')) return true;
    }
  } catch (e) {
    // ignore
  }
  return false;
}

/**
 * Patch global MediaSource and ManagedMediaSource implementations
 */
export function patchMediaCodecs() {
  if (typeof window === 'undefined') return;

  // 1. MediaSource.isTypeSupported
  try {
    if (typeof window.MediaSource !== 'undefined' && typeof window.MediaSource.isTypeSupported === 'function') {
      const origIsTypeSupported = window.MediaSource.isTypeSupported;
      window.MediaSource.isTypeSupported = function (type) {
        if (isAv1Codec(type)) return false;
        if (isHevcCodec(type)) return checkHevcSupported(origIsTypeSupported, window.MediaSource, type);
        if (typeof type === 'string' && type.includes('avc1')) {
          if (origIsTypeSupported.call(window.MediaSource, type)) return true;
          const normAvc = type.replace(/(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g, '$12a');
          if (normAvc !== type && origIsTypeSupported.call(window.MediaSource, normAvc)) return true;
        }
        return origIsTypeSupported.call(window.MediaSource, type);
      };
    }
  } catch (err) {
    console.warn('[Codecs] Failed to patch MediaSource.isTypeSupported', err);
  }

  // 2. MediaSource.prototype.addSourceBuffer
  try {
    if (typeof window.MediaSource !== 'undefined' && window.MediaSource.prototype && typeof window.MediaSource.prototype.addSourceBuffer === 'function') {
      const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
      window.MediaSource.prototype.addSourceBuffer = function (type) {
        let targetType = type;
        try {
          return origAddSourceBuffer.call(this, targetType);
        } catch (err1) {
          if (typeof targetType === 'string') {
            if (isHevcCodec(targetType)) {
              const hasAudio = targetType.includes('mp4a');
              const cleaned = cleanHevcCodec(targetType);
              if (cleaned !== targetType) {
                try { return origAddSourceBuffer.call(this, cleaned); } catch (e) {}
              }
              const swapped = cleaned.includes('hev1')
                ? cleaned.replace(/hev1/g, 'hvc1')
                : cleaned.replace(/hvc1/g, 'hev1');
              try { return origAddSourceBuffer.call(this, swapped); } catch (e) {}

              const l93 = swapped.replace(/(hvc1|hev1)(?:\.[^",]+)?/g, 'hvc1.1.6.L93.B0');
              try { return origAddSourceBuffer.call(this, l93); } catch (e) {}

              const fallbacks = [
                hasAudio ? 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"' : 'video/mp4; codecs="hvc1.1.6.L93.B0"',
                hasAudio ? 'video/mp4; codecs="hvc1,mp4a.40.2"' : 'video/mp4; codecs="hvc1"',
                hasAudio ? 'video/mp4; codecs="hev1,mp4a.40.2"' : 'video/mp4; codecs="hev1"',
                'video/mp4; codecs="hevc"'
              ];
              for (const fb of fallbacks) {
                try { return origAddSourceBuffer.call(this, fb); } catch (e) {}
              }
            }

            if (targetType.includes('avc1')) {
              const normAvc = targetType.replace(/(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g, '$12a');
              if (normAvc !== targetType) {
                try { return origAddSourceBuffer.call(this, normAvc); } catch (e) {}
              }
              const avcFallbacks = [
                'video/mp4; codecs="avc1.64002a,mp4a.40.2"',
                'video/mp4; codecs="avc1.4d002a,mp4a.40.2"',
                'video/mp4; codecs="avc1.42e01e,mp4a.40.2"'
              ];
              for (const fb of avcFallbacks) {
                try { return origAddSourceBuffer.call(this, fb); } catch (e) {}
              }
            }
          }
          throw err1;
        }
      };
    }
  } catch (err) {
    console.warn('[Codecs] Failed to patch MediaSource.prototype.addSourceBuffer', err);
  }
}

/**
 * Patches HLS master manifest text for LG webOS hardware decoder compatibility
 * and routes variant playlist requests through the AdBlock proxy
 */
export function patchMasterManifest(manifestText, serverUrl = '') {
  if (!manifestText || typeof manifestText !== 'string') return manifestText;

  const lines = manifestText.split('\n');
  const result = [];
  const isUsherProxy = serverUrl && serverUrl.includes('rte.net.ru');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Strip unsupported AV1 streams completely
    if (line.startsWith('#EXT-X-STREAM-INF:') && (line.includes('av01') || (line.includes('av1') && !line.includes('avc1')))) {
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        i++; // skip next line containing stream URL
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const is1080 = line.includes('1920x1080') || line.includes('1080p');
      const patchedLine = line.replace(/CODECS="([^"]+)"/, (_match, codecsAttr) => {
        const tokens = codecsAttr.split(',').map(t => t.trim());
        const patchedTokens = tokens.map(token => {
          // Normalize Twitch HEVC
          if (token.startsWith('hev1') || token.startsWith('hvc1')) {
            // Trim non-standard constraint flags and normalize to hvc1.1.6.L150.B0
            return 'hvc1.1.6.L150.B0';
          }
          // Normalize AVC
          if (token.startsWith('avc1.')) {
            // Twitch tags 1080p transcodes with avc1.4D401F (Level 3.1),
            // which causes webOS Starfish decoder to allocate insufficient buffers and renegotiate.
            // Normalize all 1080p AVC to Level 4.2 High Profile (avc1.64002a).
            if (is1080) {
              return 'avc1.64002a';
            }
            // Clamp AVC levels above 4.2 to 4.2 (avc1.64002a)
            const levelHex = token.slice(9, 11);
            const levelDec = parseInt(levelHex, 16);
            if (!isNaN(levelDec) && levelDec > 0x2a) {
              return 'avc1.64002a';
            }
          }
          return token;
        });
        return `CODECS="${patchedTokens.join(',')}"`;
      });

      result.push(patchedLine);
    } else if (line.startsWith('https://') && isUsherProxy) {
      // Route variant playlist requests through the AdBlock proxy so the TV never leaks its direct IP
      result.push(line.startsWith(serverUrl) ? line : `${serverUrl}${line}`);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Creates a Blob URL for the patched master manifest
 */
export function createManifestBlobUrl(manifestText, serverUrl = '') {
  const patched = patchMasterManifest(manifestText, serverUrl);
  const blob = new Blob([patched], { type: 'application/vnd.apple.mpegurl' });
  return URL.createObjectURL(blob);
}
