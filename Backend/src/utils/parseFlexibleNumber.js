export function parseFlexibleNumber(value) {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value) && value.length > 0) return parseFlexibleNumber(value[0]);
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;

    let s = value.trim();
    if (!s) return 0;
    s = s.replace(/[\u2212\u2012\u2013\u2014]/g, '-');
  
    let negative = false;
    if (/\(.*\)/.test(s)) {
      negative = true;
      s = s.replace(/[()]/g, '');
    }
    if (/-\s*$/.test(s)) {
      negative = true;
      s = s.replace(/-\s*$/, '');
    }
  
    const cleaned = s.replace(/[^0-9.+-]/g, '');
    const parsed = parseFloat(cleaned);
    if (!Number.isFinite(parsed)) return 0;
  
    if (negative && parsed > 0) return -Math.abs(parsed);
    return parsed;
  }
  
  