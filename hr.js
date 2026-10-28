/* Décodage de la caractéristique Heart Rate Measurement (0x2A37).
   Retourne { hr (bpm), contact (1 | 0 | null si non supporté), rr (ms[]) }. */
(function (root) {
  function parseHR(d) {
    const f = d.getUint8(0);
    let i = 1, hr;
    if (f & 0x01) { hr = d.getUint16(i, true); i += 2; } else { hr = d.getUint8(i); i += 1; }
    const contact = (f & 0x04) ? ((f & 0x02) ? 1 : 0) : null;
    if (f & 0x08) i += 2; // énergie dépensée (ignorée)
    const rr = [];
    if (f & 0x10) {
      while (i + 1 < d.byteLength) {
        rr.push(Math.round(d.getUint16(i, true) * 1000 / 1024)); // unités 1/1024 s -> ms
        i += 2;
      }
    }
    return { hr, contact, rr };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseHR };
  else root.parseHR = parseHR;
})(typeof window !== 'undefined' ? window : globalThis);
