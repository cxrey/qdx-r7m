/**
 * Detects if a search input is a Polymarket URL, slug, or ID.
 * Returns detection result with type and extracted identifier.
 *
 * @param {string} input - Raw search input value
 * @returns {{ type: string, extracted: string, outcomeId: string|null }}
 */
export function detectMarketLink(input) {
  const RESULT_TEXT = { type: 'TEXT', extracted: null, outcomeId: null };

  if (!input || typeof input !== 'string') return RESULT_TEXT;

  const trimmed = input.trim().replace(/^["']+|["']+$/g, '');
  if (!trimmed) return RESULT_TEXT;

  // Helper: extract tid or outcome query param from a URL string
  function extractOutcomeId(urlStr) {
    try {
      const qIdx = urlStr.indexOf('?');
      if (qIdx === -1) return null;
      const params = new URLSearchParams(urlStr.slice(qIdx));
      return params.get('tid') || params.get('outcome') || null;
    } catch {
      return null;
    }
  }

  // Helper: extract slug from a URL path segment, stripping query/hash/trailing slash
  function extractSlug(pathSegment) {
    return pathSegment
      .split('?')[0]
      .split('#')[0]
      .replace(/\/+$/, '');
  }

  // 1. POLYMARKET EVENT URL
  const eventUrlMatch = trimmed.match(/(?:m\.)?polymarket\.com\/event\/([a-z0-9][a-z0-9-]*[a-z0-9])/i);
  if (eventUrlMatch) {
    const slug = extractSlug(eventUrlMatch[1]);
    if (slug) {
      return { type: 'EVENT_URL', extracted: slug.toLowerCase(), outcomeId: extractOutcomeId(trimmed) };
    }
  }

  // 2. POLYMARKET MARKET URL
  const marketUrlMatch = trimmed.match(/(?:m\.)?polymarket\.com\/market\/([a-z0-9][a-z0-9-]*[a-z0-9])/i);
  if (marketUrlMatch) {
    const slug = extractSlug(marketUrlMatch[1]);
    if (slug) {
      return { type: 'MARKET_URL', extracted: slug.toLowerCase(), outcomeId: extractOutcomeId(trimmed) };
    }
  }

  // 3. POLYMARKETSCAN URL
  const scanUrlMatch = trimmed.match(/polymarketscan\.org\/(event|market)\/([a-z0-9][a-z0-9-]*[a-z0-9])/i);
  if (scanUrlMatch) {
    const slug = extractSlug(scanUrlMatch[2]);
    if (slug) {
      return { type: 'SCAN_URL', extracted: slug.toLowerCase(), outcomeId: null };
    }
  }

  // Only check non-URL patterns if the input doesn't look like a URL
  if (trimmed.includes('://') || trimmed.includes('.')) return RESULT_TEXT;

  // 4. MARKET ID (4-8 digits)
  if (/^\d{4,8}$/.test(trimmed)) {
    return { type: 'MARKET_ID', extracted: trimmed, outcomeId: null };
  }

  // 5. CONDITION ID: 0x + 64 hex digits (a bytes32)
  if (/^0x[0-9a-f]{64}$/i.test(trimmed)) {
    return { type: 'CONDITION_ID', extracted: trimmed.toLowerCase(), outcomeId: null };
  }

  // 6. TOKEN ID: a long decimal number (CTF token ID, or a Protocol V2 position ID)
  if (/^\d{10,}$/.test(trimmed)) {
    return { type: 'TOKEN_ID', extracted: trimmed, outcomeId: null };
  }

  // 7. RAW SLUG (20+ chars, lowercase alphanumeric with hyphens, no spaces)
  if (/^[a-z0-9]([a-z0-9-]{18,})[a-z0-9]$/.test(trimmed) && trimmed.includes('-') && !trimmed.includes(' ')) {
    return { type: 'SLUG', extracted: trimmed, outcomeId: null };
  }

  // 8. Normal text search
  return RESULT_TEXT;
}

/**
 * Strips trailing numeric segments from a slug.
 * e.g., "my-market-slug-962-364-677" → "my-market-slug"
 */
export function truncateSlugNumerics(slug) {
  // Remove trailing segments that are purely numeric
  const parts = slug.split('-');
  let i = parts.length - 1;
  while (i > 0 && /^\d+$/.test(parts[i])) {
    i--;
  }
  const truncated = parts.slice(0, i + 1).join('-');
  // Only return truncated if it's meaningfully shorter
  return truncated !== slug && truncated.length >= 5 ? truncated : null;
}
