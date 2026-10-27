// Splits a wholesale title like "Corona berry 24 cm Ref: T298 (UND)" into name, reference and
// sales unit. Same rules as the theme's snippets/product-name-parts.liquid, so the catalog and
// the store show products the same way.

const MEASURES = new Set(['', 'cm', 'cms', 'mm', 'm', 'mt', 'mts', 'ml', 'l', 'lt', 'lts', 'litros', 'litro', 'g', 'gr', 'grs', 'gramos', 'kg', 'oz', 'w', 'v', 'mah', 'gb', 'x', 'und', 'unid', 'pzs', 'pcs', 'in', 'pulg', 'hz', 'k', 'p', 'cc']);
const MARKERS = ['Ref:', 'ref:', 'REF:', 'Ref.', 'ref.', 'Ref ', 'REF ', 'ref '];
const UNIT_LABELS = { DC: 'x docena', PAQ: 'x paquete', CJ: 'x caja' };
// Green tag under the price, same text as the store's product cards
const PRICE_TAGS = { UND: 'Precio mayorista x unidad', UNID: 'Precio mayorista x unidad', DC: 'Precio mayorista x docena', PAQ: 'Precio mayorista x paquete', CJ: 'Precio mayorista x caja' };

const isDigit = (c) => c >= '0' && c <= '9';

function partirNombre(title) {
  let name = String(title || '').trim();
  let reference = '';
  let unit = '';

  // Sales unit at the end: "(UND)", "(DC)"
  const unitMatch = name.match(/\(([^()]{1,4})\)\s*$/);
  if (unitMatch && unitMatch[1].trim()) {
    unit = unitMatch[1].trim().toUpperCase();
    name = name.slice(0, unitMatch.index).trim();
  }

  for (const marker of MARKERS) {
    const at = name.indexOf(marker);
    if (at > 0) {
      reference = name.slice(at + marker.length).trim();
      name = name.slice(0, at).trim();
      break;
    }
    if (at === 0) break;
  }

  // Codes without "Ref" among the last 3 words, skipping measures: "Balde MT4114 4.5 L"
  if (!reference) {
    const words = name.split(' ');
    for (let offset = 1; offset <= 3; offset++) {
      const idx = words.length - offset;
      if (idx < 1) break;
      const word = words[idx];
      const lower = word.toLowerCase();
      const withoutDigits = lower.replace(/[0-9]/g, '');
      const digitCount = lower.length - withoutDigits.length;
      const letters = withoutDigits.replace(/[.,/-]/g, '');
      const startsWithDigit = isDigit(lower[0]);

      let isCode = false;
      if (digitCount >= 2 && !/[*×:]/.test(word)) {
        if (startsWithDigit) {
          if (!letters) {
            if (word.includes('-') && word.length >= 5) isCode = true;
            else if (offset === 1 && digitCount === word.length && (word.length >= 4 || (lower[0] === '0' && word.length >= 3))) isCode = true;
          } else if (letters[0] !== 'x' && !MEASURES.has(letters) && word.length >= 4) {
            isCode = true;
          }
        } else if (lower[0] === 'x') {
          // "x750": a quantity
        } else if (letters.length > 1 && letters.endsWith('x')) {
          // "CA27x20": a dimension
        } else if (word.length >= 4) {
          isCode = true;
        }
      }

      if (isCode) {
        const previous = words[idx - 1] || '';
        if (previous.toLowerCase() === 'x') break;
        reference = word;
        let refStart = idx;
        // Keep a short uppercase prefix with plain numbers: "CA 22243"
        if (digitCount === word.length && idx - 1 >= 1 && previous === previous.toUpperCase() && previous.length >= 2 && previous.length <= 3 && !/[0-9]/.test(previous)) {
          reference = `${previous} ${word}`;
          refStart = idx - 1;
        }
        if (reference.slice(0, 3).toLowerCase() === 'ref' && reference.length > 3) {
          reference = reference.slice(3).replace(/^[:.]/, '').trim();
        }
        name = [...words.slice(0, refStart), ...words.slice(idx + 1)].join(' ').trim();
        break;
      }

      const isMeasure = MEASURES.has(lower) || (startsWithDigit && (!letters || letters[0] === 'x' || MEASURES.has(letters))) || (lower[0] === 'x' && isDigit(lower[1]));
      if (!isMeasure) break;
    }
  }

  const priceTag = unit ? PRICE_TAGS[unit] || 'Precio mayorista' : '';
  return { name, reference, unit, unitLabel: UNIT_LABELS[unit] || '', priceTag };
}

module.exports = { partirNombre };
