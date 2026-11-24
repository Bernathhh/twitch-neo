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

  const mediaSources = [window.MediaSource, window.ManagedMediaSource].filter(Boolean);

  for (const MS of mediaSources) {
    // 1. isTypeSupported
    try {
      if (typeof MS.isTypeSupported === 'function' && !MS.isTypeSupported.__twitchNeoPatched) {
        const origIsTypeSupported = MS.isTypeSupported;
        const patchedIsTypeSupported = function (type) {
          if (isAv1Codec(type)) return false;
          if (isHevcCodec(type)) return checkHevcSupported(origIsTypeSupported, MS, type);
          if (typeof type === 'string' && type.includes('avc1')) {
            if (origIsTypeSupported.call(MS, type)) return true;
            const normAvc = type.replace(/(avc1\.[0-9a-fA-F]{4})3[0-9a-fA-F]/g, '$12a');
            if (normAvc !== type && origIsTypeSupported.call(MS, normAvc)) return true;
          }
          return origIsTypeSupported.call(MS, type);
        };
        patchedIsTypeSupported.__twitchNeoPatched = true;
        MS.isTypeSupported = patchedIsTypeSupported;
      }
    } catch (err) {
      console.warn('[Codecs] Failed to patch isTypeSupported', err);
    }

    // 2. prototype.addSourceBuffer
    try {
      if (MS.prototype && typeof MS.prototype.addSourceBuffer === 'function' && !MS.prototype.addSourceBuffer.__twitchNeoPatched) {
        const origAddSourceBuffer = MS.prototype.addSourceBuffer;
        const patchedAddSourceBuffer = function (type) {
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
        patchedAddSourceBuffer.__twitchNeoPatched = true;
        MS.prototype.addSourceBuffer = patchedAddSourceBuffer;
      }
    } catch (err) {
      console.warn('[Codecs] Failed to patch addSourceBuffer', err);
    }
  }
}

/**
 * Patches HLS master manifest text for LG webOS hardware decoder compatibility
 */
export function patchMasterManifest(manifestText) {
  if (!manifestText || typeof manifestText !== 'string') return manifestText;

  const lines = manifestText.split('\n');
  const result = [];

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
      const patchedLine = line.replace(/CODECS="([^"]+)"/, (_match, codecsAttr) => {
        const tokens = codecsAttr.split(',').map(t => t.trim());
        const patchedTokens = tokens.map(token => {
          // Normalize Twitch HEVC
          if (token.startsWith('hev1') || token.startsWith('hvc1')) {
            // Trim non-standard constraint flags and normalize to hvc1.1.6.L150.B0
            return 'hvc1.1.6.L150.B0';
          }
          // Clamp AVC levels above 4.2 to 4.2 while preserving exact profile (e.g. 4D40 / 6400)
          if (token.startsWith('avc1.') && token.length >= 11) {
            const levelHex = token.slice(9, 11);
            const levelDec = parseInt(levelHex, 16);
            if (!isNaN(levelDec) && levelDec > 0x2a) {
              return `${token.slice(0, 9)}2a`;
            }
          }
          return token;
        });
        return `CODECS="${patchedTokens.join(',')}"`;
      });

      result.push(patchedLine);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Creates a Blob URL for the patched master manifest
 */
export function createManifestBlobUrl(manifestText) {
  const patched = patchMasterManifest(manifestText);
  const blob = new Blob([patched], { type: 'application/vnd.apple.mpegurl' });
  return URL.createObjectURL(blob);
}
