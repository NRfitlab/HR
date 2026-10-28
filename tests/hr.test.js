const { parseHR } = require('../hr.js');
const dv = a => new DataView(new Uint8Array(a).buffer);
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', JSON.stringify(a), JSON.stringify(b)); process.exit(1); } };
eq(parseHR(dv([0x16, 72, 0x00, 0x04])), { hr: 72, contact: 1, rr: [1000] });
eq(parseHR(dv([0x01, 0x2C, 0x01])), { hr: 300, contact: null, rr: [] });
eq(parseHR(dv([0x18, 80, 0x0A, 0x00, 0x00, 0x04, 0x00, 0x02])), { hr: 80, contact: null, rr: [1000, 500] });
eq(parseHR(dv([0x04, 0])), { hr: 0, contact: 0, rr: [] });
console.log('parser OK');
