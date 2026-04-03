/**
 * mrz-parser.js
 * Parses ICAO 9303 Machine Readable Zone (MRZ) data from passports (TD3 format).
 *
 * TD3 format: 2 lines × 44 characters
 *
 * Line 1: P<ISSUER<<SURNAME<<GIVEN_NAMES<<<<<<<<<<<<<<
 *         ─┬─────────────────────────────────────────
 *          └ [0]   Document type (P = passport)
 *            [1]   Document sub-type (<, V, etc.)
 *            [2-4] Issuing country (3-letter ICAO code)
 *            [5-43] Names (44 chars): SURNAME<<GIVEN_NAMES
 *
 * Line 2: PPPPPPPPPCCCYYYYMMDDCXXXXXXXYYYYMMDDCPPPPPPPPPPPPPPCC
 *         [0-8]   Passport number (9)
 *         [9]     Passport number check digit
 *         [10-12] Nationality (3-letter ICAO)
 *         [13-18] Date of birth YYMMDD
 *         [19]    DOB check digit
 *         [20]    Sex (M / F / <)
 *         [21-26] Expiry date YYMMDD
 *         [27]    Expiry check digit
 *         [28-41] Optional / personal number (14)
 *         [42]    Optional check digit
 *         [43]    Composite check digit
 */

'use strict';

const MRZParser = (() => {

  /* ── ICAO 9303 Check digit ── */
  const CHECK_WEIGHTS = [7, 3, 1];
  const CHAR_VALUES = Object.fromEntries([
    ...Array.from({ length: 10 }, (_, i) => [String(i), i]),
    ...Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), 10 + i]),
    ['<', 0],
  ]);

  function computeCheckDigit(str) {
    let total = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i].toUpperCase();
      const val = CHAR_VALUES[ch] ?? 0;
      total += val * CHECK_WEIGHTS[i % 3];
    }
    return total % 10;
  }

  function verifyCheckDigit(str, expectedDigit) {
    if (expectedDigit === '<') return null; // not checked
    const expected = parseInt(expectedDigit, 10);
    if (isNaN(expected)) return false;
    return computeCheckDigit(str) === expected;
  }

  /* ── Date helpers ── */
  function parseMRZDate(yymmdd) {
    if (!yymmdd || yymmdd.includes('<')) return null;
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = parseInt(yymmdd.slice(2, 4), 10);
    const dd = parseInt(yymmdd.slice(4, 6), 10);
    if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return null;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

    // Pivot year: if 2-digit year ≤ current year's last 2 digits + 10 → 20xx, else 19xx
    const currentYear = new Date().getFullYear();
    const pivot = (currentYear + 10) % 100;
    const fullYear = yy <= pivot ? 2000 + yy : 1900 + yy;

    return {
      year:  fullYear,
      month: mm,
      day:   dd,
      iso:   `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
      display: new Date(fullYear, mm - 1, dd)
        .toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' }),
    };
  }

  /* ── Country codes (ICAO 3-letter → display name) ── */
  const COUNTRY_NAMES = {
    AFG:'Afghanistan', ALB:'Albania', DZA:'Algeria', AND:'Andorra', AGO:'Angola',
    ARG:'Argentina', ARM:'Armenia', AUS:'Australia', AUT:'Austria', AZE:'Azerbaijan',
    BHS:'Bahamas', BHR:'Bahrain', BGD:'Bangladesh', BLR:'Belarus', BEL:'Belgium',
    BLZ:'Belize', BEN:'Benin', BTN:'Bhutan', BOL:'Bolivia', BIH:'Bosnia & Herzegovina',
    BWA:'Botswana', BRA:'Brazil', BRN:'Brunei', BGR:'Bulgaria', BFA:'Burkina Faso',
    BDI:'Burundi', CPV:'Cabo Verde', KHM:'Cambodia', CMR:'Cameroon', CAN:'Canada',
    CAF:'Central African Republic', TCD:'Chad', CHL:'Chile', CHN:'China', COL:'Colombia',
    COM:'Comoros', COD:'Congo (DRC)', COG:'Congo (Republic)', CRI:'Costa Rica',
    CIV:"Côte d'Ivoire", HRV:'Croatia', CUB:'Cuba', CYP:'Cyprus', CZE:'Czech Republic',
    DNK:'Denmark', DJI:'Djibouti', DOM:'Dominican Republic', ECU:'Ecuador', EGY:'Egypt',
    SLV:'El Salvador', GNQ:'Equatorial Guinea', ERI:'Eritrea', EST:'Estonia', ETH:'Ethiopia',
    FJI:'Fiji', FIN:'Finland', FRA:'France', GAB:'Gabon', GMB:'Gambia', GEO:'Georgia',
    DEU:'Germany', GHA:'Ghana', GRC:'Greece', GTM:'Guatemala', GIN:'Guinea',
    GNB:'Guinea-Bissau', GUY:'Guyana', HTI:'Haiti', HND:'Honduras', HUN:'Hungary',
    ISL:'Iceland', IND:'India', IDN:'Indonesia', IRN:'Iran', IRQ:'Iraq', IRL:'Ireland',
    ISR:'Israel', ITA:'Italy', JAM:'Jamaica', JPN:'Japan', JOR:'Jordan', KAZ:'Kazakhstan',
    KEN:'Kenya', PRK:'North Korea', KOR:'South Korea', KWT:'Kuwait', KGZ:'Kyrgyzstan',
    LAO:'Laos', LVA:'Latvia', LBN:'Lebanon', LSO:'Lesotho', LBR:'Liberia', LBY:'Libya',
    LIE:'Liechtenstein', LTU:'Lithuania', LUX:'Luxembourg', MDG:'Madagascar', MWI:'Malawi',
    MYS:'Malaysia', MDV:'Maldives', MLI:'Mali', MLT:'Malta', MRT:'Mauritania',
    MUS:'Mauritius', MEX:'Mexico', MDA:'Moldova', MCO:'Monaco', MNG:'Mongolia',
    MNE:'Montenegro', MAR:'Morocco', MOZ:'Mozambique', MMR:'Myanmar', NAM:'Namibia',
    NPL:'Nepal', NLD:'Netherlands', NZL:'New Zealand', NIC:'Nicaragua', NER:'Niger',
    NGA:'Nigeria', MKD:'North Macedonia', NOR:'Norway', OMN:'Oman', PAK:'Pakistan',
    PAN:'Panama', PNG:'Papua New Guinea', PRY:'Paraguay', PER:'Peru', PHL:'Philippines',
    POL:'Poland', PRT:'Portugal', QAT:'Qatar', ROU:'Romania', RUS:'Russia', RWA:'Rwanda',
    SAU:'Saudi Arabia', SEN:'Senegal', SRB:'Serbia', SLE:'Sierra Leone', SGP:'Singapore',
    SVK:'Slovakia', SVN:'Slovenia', SOM:'Somalia', ZAF:'South Africa', SSD:'South Sudan',
    ESP:'Spain', LKA:'Sri Lanka', SDN:'Sudan', SUR:'Suriname', SWE:'Sweden', CHE:'Switzerland',
    SYR:'Syria', TWN:'Taiwan', TJK:'Tajikistan', TZA:'Tanzania', THA:'Thailand',
    TLS:'Timor-Leste', TGO:'Togo', TTO:'Trinidad & Tobago', TUN:'Tunisia', TUR:'Turkey',
    TKM:'Turkmenistan', UGA:'Uganda', UKR:'Ukraine', ARE:'UAE', GBR:'United Kingdom',
    USA:'United States', URY:'Uruguay', UZB:'Uzbekistan', VEN:'Venezuela', VNM:'Vietnam',
    YEM:'Yemen', ZMB:'Zambia', ZWE:'Zimbabwe',
    D:'Germany', GBD:'British Dependent Territories', UTO:'Utopia', XXA:'Stateless',
  };

  function countryName(code) {
    if (!code) return code;
    const clean = code.replace(/<+$/, '');
    return COUNTRY_NAMES[clean] || clean;
  }

  /* ── Name parsing ── */
  function parseName(nameField) {
    // Standard ICAO split: surname<<given names
    if (nameField.includes('<<')) {
      const [surnamePart, ...givenParts] = nameField.split('<<');
      const surname = surnamePart.replace(/</g, '').trim();
      const givenNames = givenParts
        .join(' ')
        .replace(/</g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
      return { surname, givenNames, fullName: [surname, givenNames].filter(Boolean).join(', ') };
    }

    // Fallback: << was not found (OCR noise still present).
    // Extract word sequences of 4+ letters — first = surname, second = given name.
    const words = nameField.replace(/[^A-Z]/g, ' ').split(/\s+/).filter(w => w.length >= 4);
    if (words.length >= 2) {
      const surname = words[0];
      const givenNames = words[1];
      return { surname, givenNames, fullName: `${surname}, ${givenNames}` };
    }
    if (words.length === 1) {
      return { surname: words[0], givenNames: '', fullName: words[0] };
    }
    // Last resort: return whatever non-filler text is there
    const raw = nameField.replace(/[^A-Z]/g, ' ').trim().split(/\s+/)[0] || nameField;
    return { surname: raw, givenNames: '', fullName: raw };
  }

  /* ── Sex field ── */
  function parseSex(ch) {
    return ch === 'M' ? 'Male' : ch === 'F' ? 'Female' : 'Unspecified';
  }

  /* ── Clean filler ── */
  function clean(str) {
    return str.replace(/<+$/, '').replace(/<+/g, ' ').trim();
  }

  /* ── OCR normalization ── */
  /*
   * ICAO 9303 TD3 position types (passport):
   *
   * LINE 1 — all 44 positions are ALPHA or < (A-Z, filler <)
   *   [0]     document type  (P)
   *   [1]     subtype        (< or letter)
   *   [2-4]   issuing country (A-Z or <)
   *   [5-43]  name field     (A-Z or <)
   *
   * LINE 2 — mixed types:
   *   [0-8]   passport number  ALPHANUMERIC (A-Z, 0-9, <)
   *   [9]     check digit      DIGIT 0-9
   *   [10-12] nationality      ALPHA A-Z or <
   *   [13-18] date of birth    DIGIT 0-9
   *   [19]    check digit      DIGIT 0-9
   *   [20]    sex              ALPHA M / F / <
   *   [21-26] expiry date      DIGIT 0-9
   *   [27]    check digit      DIGIT 0-9
   *   [28-41] optional/PIN     ALPHANUMERIC
   *   [42]    check digit      DIGIT 0-9 (or < if unused)
   *   [43]    composite check  DIGIT 0-9
   *
   * Common OCR-B misreads:  < → L, < → Z, O → 0, I → 1, S → 5, B → 8, G → 6
   */

  // Alpha-to-digit substitutions for strictly numeric positions
  const ALPHA_TO_DIGIT = {
    O:'0', Q:'0', D:'0', C:'0',
    I:'1', L:'1',
    Z:'2',
    E:'3',
    S:'5',
    G:'6',
    T:'7',
    B:'8',
  };

  // Digit-to-alpha substitutions for strictly alpha positions
  const DIGIT_TO_ALPHA = {
    '0':'O', '1':'I', '5':'S', '8':'B',
  };

  // Strictly numeric positions in Line 2
  const NUMERIC_L2 = new Set([9, 13,14,15,16,17,18, 19, 21,22,23,24,25,26, 27, 42, 43]);
  // Strictly alpha positions in Line 2
  const ALPHA_L2   = new Set([10, 11, 12, 20]);

  function normalizeMRZChar(ch, pos, lineIdx) {
    if (lineIdx === 1 && NUMERIC_L2.has(pos)) {
      // Position MUST be a digit
      if (/[0-9]/.test(ch)) return ch;
      return ALPHA_TO_DIGIT[ch] ?? '0';
    }
    if (lineIdx === 0 || (lineIdx === 1 && ALPHA_L2.has(pos))) {
      // Position MUST be alpha or <
      if (/[A-Z<]/.test(ch)) return ch;
      return DIGIT_TO_ALPHA[ch] ?? '<';
    }
    return ch; // alphanumeric positions: leave as-is
  }

  function normalizeMRZLine(line, lineIndex) {
    let n = line.toUpperCase().replace(/[^A-Z0-9<]/g, '<');

    if (lineIndex === 0) {
      // Line 1: ALL 44 positions are alpha or <  (ICAO 9303 §4)
      // Tesseract reads the OCR-B < filler as various letters: L, Z, K, C, W, X…
      // Strategy: count each letter in the name field (pos 5+).
      // Any letter appearing far more than it could in a real name is a filler misread.
      const nameSection = n.slice(5);
      const freq = {};
      for (const ch of nameSection) {
        if (/[A-Z]/.test(ch)) freq[ch] = (freq[ch] || 0) + 1;
      }

      // Phase 1 — known high-probability filler misreads
      // Replace runs of 2+ when count exceeds plausible name usage
      const rules = [
        ['C', 5, 3],   // C{3+} when C appears 5+ times  (< often → C in OCR-B)
        ['L', 4, 2],   // L{2+} when L appears 4+ times
        ['Z', 3, 3],   // Z{3+} when Z appears 3+ times
        ['K', 2, 2],   // K{2+} when K appears 2+ times  (<< often → KK)
        ['W', 2, 2],   // W{2+} when W appears 2+ times
        ['X', 2, 2],   // X rarely in names
        ['Y', 3, 2],
      ];
      for (const [ch, minCount, minRun] of rules) {
        if ((freq[ch] || 0) >= minCount) {
          n = n.replace(new RegExp(`${ch}{${minRun},}`, 'g'), m => '<'.repeat(m.length));
        }
      }

      // Phase 2 — generic: any letter appearing 6+ times in name field
      // that exceeds its realistic name presence → replace runs of 3+
      const updatedFreq = {};
      for (const ch of n.slice(5)) {
        if (/[A-Z]/.test(ch)) updatedFreq[ch] = (updatedFreq[ch] || 0) + 1;
      }
      for (const [ch, cnt] of Object.entries(updatedFreq)) {
        if (cnt >= 6) {
          n = n.replace(new RegExp(`${ch}{3,}`, 'g'), m => '<'.repeat(m.length));
        }
        if (cnt >= 10) {
          n = n.replace(new RegExp(`${ch}{2,}`, 'g'), m => '<'.repeat(m.length));
        }
      }

    } else {
      // Line 2 — only L and Z filler detection (more conservative)
      const lCount = (n.match(/L/g) || []).length;
      const zCount = (n.match(/Z/g) || []).length;
      if (lCount > 5) n = n.replace(/L{2,}/g, m => '<'.repeat(m.length));
      if (zCount > 4) n = n.replace(/Z{3,}/g, m => '<'.repeat(m.length));
    }

    // Per-position type enforcement (ICAO position rules)
    n = n.split('').map((ch, i) => normalizeMRZChar(ch, i, lineIndex)).join('');

    return n;
  }

  /* ── Extract MRZ lines from OCR text ── */
  /**
   * Tries to find two consecutive 44-character MRZ lines in OCR output.
   * Returns [line1, line2] or null if not found.
   */
  function extractMRZLines(ocrText) {
    if (!ocrText) return null;

    // Normalize: uppercase, strip everything except A-Z 0-9 < and newlines
    const normalized = ocrText
      .toUpperCase()
      .replace(/[^A-Z0-9<\n]/g, ' ')
      .replace(/ {2,}/g, ' ');

    const lines = normalized.split('\n').map(l => l.replace(/\s+/g, '').trim()).filter(Boolean);
    const candidates = [];

    for (const raw of lines) {
      if (raw.length >= 30) {
        candidates.push(raw);
      }
    }

    // ── Strategy 1: consecutive pair near 44 chars ──
    for (let i = 0; i < candidates.length - 1; i++) {
      const a = candidates[i];
      const b = candidates[i + 1];
      if (a.length >= 30 && b.length >= 30) {
        const l1 = a.padEnd(44, '<').slice(0, 44);
        const l2 = b.padEnd(44, '<').slice(0, 44);
        // Line 1 should start with P (passport) — also accept common OCR confusions
        if (/^[P]/.test(l1)) {
          return [normalizeMRZLine(l1, 0), normalizeMRZLine(l2, 1)];
        }
      }
    }

    // ── Strategy 2: any pair where line 1 has lots of '<' (filler chars) ──
    for (let i = 0; i < candidates.length - 1; i++) {
      const a = candidates[i];
      const b = candidates[i + 1];
      const aFillerRatio = (a.match(/</g) || []).length / a.length;
      const bHasDigits = /\d{6}/.test(b); // DOB or expiry digits on line 2
      if (a.length >= 30 && b.length >= 30 && aFillerRatio > 0.2 && bHasDigits) {
        const l1 = a.padEnd(44, '<').slice(0, 44);
        const l2 = b.padEnd(44, '<').slice(0, 44);
        return [normalizeMRZLine(l1, 0), normalizeMRZLine(l2, 1)];
      }
    }

    // ── Strategy 3: find 88-char block (both lines concatenated) ──
    const allText = candidates.join('');
    const match = allText.match(/P.{43}[A-Z0-9<]{44}/);
    if (match) {
      const combined = match[0];
      return [
        normalizeMRZLine(combined.slice(0, 44), 0),
        normalizeMRZLine(combined.slice(44, 88), 1),
      ];
    }

    // ── Strategy 4: look for a line with 6+ consecutive digits (DOB/expiry) ──
    // and use it as line 2, the line before it as line 1
    for (let i = 1; i < candidates.length; i++) {
      if (/\d{6}/.test(candidates[i]) && candidates[i-1].length >= 25) {
        const l1 = candidates[i-1].padEnd(44, '<').slice(0, 44);
        const l2 = candidates[i].padEnd(44, '<').slice(0, 44);
        return [normalizeMRZLine(l1, 0), normalizeMRZLine(l2, 1)];
      }
    }

    return null;
  }

  /* ── Main parse function ── */
  /**
   * Parse TD3 passport MRZ.
   * @param {string} line1 - 44-char line 1
   * @param {string} line2 - 44-char line 2
   * @returns {Object} parsed passport data
   */
  function parseTD3(line1, line2) {
    const result = {
      valid: false,
      errors: [],
      raw: { line1, line2 },
    };

    if (!line1 || line1.length !== 44) {
      result.errors.push('Line 1 is not 44 characters');
      return result;
    }
    if (!line2 || line2.length !== 44) {
      result.errors.push('Line 2 is not 44 characters');
      return result;
    }

    // Line 1 fields
    result.documentType    = line1[0];
    result.documentSubtype = line1[1] === '<' ? '' : line1[1];
    result.issuingCountry  = line1.slice(2, 5).replace(/<+$/, '');
    result.issuingCountryName = countryName(result.issuingCountry);

    const nameField = line1.slice(5, 44);
    const { surname, givenNames, fullName } = parseName(nameField);
    result.surname    = surname;
    result.givenNames = givenNames;
    result.fullName   = fullName;

    // Line 2 fields
    result.passportNumber = clean(line2.slice(0, 9));
    const pnCheckDigit    = line2[9];
    result.nationality    = line2.slice(10, 13).replace(/<+$/, '');
    result.nationalityName = countryName(result.nationality);

    const dobRaw = line2.slice(13, 19);
    const dobCheck = line2[19];
    result.sex = parseSex(line2[20]);

    const expiryRaw   = line2.slice(21, 27);
    const expiryCheck = line2[27];
    const optional    = line2.slice(28, 42);
    const optCheck    = line2[42];
    const compositeCheck = line2[43];

    // Dates
    result.dateOfBirth = parseMRZDate(dobRaw);
    result.expiryDate  = parseMRZDate(expiryRaw);

    // Optional / personal number
    result.personalNumber = clean(optional) || null;

    // Check digit verification
    const checks = {
      passportNumber: verifyCheckDigit(line2.slice(0, 9), pnCheckDigit),
      dateOfBirth:    verifyCheckDigit(dobRaw, dobCheck),
      expiryDate:     verifyCheckDigit(expiryRaw, expiryCheck),
      optional:       verifyCheckDigit(optional, optCheck),
      composite:      verifyCheckDigit(
        line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43),
        compositeCheck
      ),
    };
    result.checkDigits = checks;

    const failedChecks = Object.entries(checks)
      .filter(([, v]) => v === false)
      .map(([k]) => k);

    if (failedChecks.length > 0) {
      result.errors.push(`Check digit failure: ${failedChecks.join(', ')}`);
    }

    // Expiry status
    if (result.expiryDate) {
      const expiry = new Date(result.expiryDate.year, result.expiryDate.month - 1, result.expiryDate.day);
      result.expired = expiry < new Date();
    }

    result.valid = failedChecks.length === 0;
    return result;
  }

  /* ── Public API ── */
  return {
    /**
     * Parse raw OCR text: extracts MRZ lines then parses them.
     * @param {string} ocrText
     * @returns {{ data: Object|null, lines: string[]|null, error: string|null }}
     */
    parseFromOCR(ocrText) {
      const lines = extractMRZLines(ocrText);
      if (!lines) {
        return { data: null, lines: null, error: 'Could not detect MRZ lines in the image.' };
      }
      const data = parseTD3(lines[0], lines[1]);
      return { data, lines, error: data.errors.length > 0 ? data.errors.join('; ') : null };
    },

    /**
     * Parse explicit MRZ lines.
     */
    parseLines(line1, line2) {
      return parseTD3(
        normalizeMRZLine(line1, 0),
        normalizeMRZLine(line2, 1)
      );
    },

    extractMRZLines,
    normalizeMRZLine,
    computeCheckDigit,
  };

})();

// Export for module environments; no-op in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MRZParser;
}
