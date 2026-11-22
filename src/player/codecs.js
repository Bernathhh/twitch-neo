/**
 * Video Codec Normalizer & Manifest Patcher for LG webOS TV
 *
 * Fixes:
 * 1. Twitch 1440p60 HEVC non-standard hev1 + trailing zeros -> hvc1.1.6.L150.B0 / hvc1.1.6.L93.B0
 * 2. AVC Level 5.x -> avc1.64002a (Level 4.2 High Profile, standard TV hardware maximum)
 * 3. Removes unsupported AV1 (av01) streams that cause black screen / decoder stall on webOS
 */

export function getSupportedHevcCodec() {
  const candidates = [
    'hvc1.1.6.L150.B0', // Level 5.0 Main Tier (Standard for 1440p60)
    'hvc1.1.6.L153.B0', // Level 5.1 Main Tier
    'hvc1.1.6.L120.B0', // Level 4.0
    'hvc1.1.6.L93.B0',  // Level 3.1 Main Tier (Universal webOS fallback)
    'hev1.1.6.L150.B0'
  ];

  if (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function') {
    for (const c of candidates) {
      try {
        if (MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)) {
          return c;
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // Fallback to Level 5.0 (supports 2560x1440@60)
  return 'hvc1.1.6.L150.B0';
}

/**
 * Patches HLS master manifest text for LG webOS hardware decoder compatibility
 */
export function patchMasterManifest(manifestText) {
  if (!manifestText || typeof manifestText !== 'string') return manifestText;

  const targetHevcCodec = getSupportedHevcCodec();
  const lines = manifestText.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Strip unsupported AV1 streams completely
    if (line.startsWith('#EXT-X-STREAM-INF:') && line.includes('av01')) {
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        i++; // skip next line containing stream URL
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const patchedLine = line.replace(/CODECS="([^"]+)"/, (_match, codecsAttr) => {
        const tokens = codecsAttr.split(',').map(t => t.trim());
        const patchedTokens = tokens.map(token => {
          // Normalize HEVC
          if (token.startsWith('hev1') || token.startsWith('hvc1')) {
            return targetHevcCodec;
          }
          // Clamp AVC levels above 4.2 to 4.2 (avc1.64002a)
          if (token.startsWith('avc1.')) {
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
