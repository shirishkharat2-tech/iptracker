'use strict';
// Credential-free compatibility probe. Do not send application data until
// the exact certificate, CA signature and validity dates have been verified.
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const expected = 'BF:B2:D7:E6:32:0E:65:24:EB:E4:5A:46:14:44:A4:60:29:60:F9:AD:2F:C1:C7:98:CC:99:92:76:1D:78:CE:B6';
const ca = new X509Certificate(fs.readFileSync(path.join(__dirname, '../config/sophos-ca.pem')));
const socket = tls.connect({
  host: '192.168.1.1', port: 4444,
  // Legacy appliance has a weak key and no IP SAN. Replace normal identity
  // validation on this socket only with explicit pin + CA validation below.
  rejectUnauthorized: false,
}, () => {
  try {
    const cert = new X509Certificate(socket.getPeerCertificate().raw);
    const now = Date.now();
    if (cert.fingerprint256 !== expected) throw new Error('Firewall certificate changed; connection refused.');
    if (!ca.ca || !cert.verify(ca.publicKey)) throw new Error('Certificate not signed by the supplied appliance CA.');
    for (const item of [ca, cert]) {
      if (!(now >= Date.parse(item.validFrom) && now <= Date.parse(item.validTo))) throw new Error('Certificate outside its validity period.');
    }
    console.log('Certificate pin, CA signature and validity verified.');
    console.log(`Negotiated ${socket.getProtocol()} / ${socket.getCipher().name}`);
    socket.write('GET /webconsole/APIController HTTP/1.1\r\nHost: 192.168.1.1:4444\r\nConnection: close\r\n\r\n');
  } catch (error) { socket.destroy(error); }
});
let response = '';
socket.on('data', data => {
  response += data.toString('utf8');
  if (response.length > 65536) socket.destroy(new Error('Unexpected response size.'));
});
socket.setTimeout(10000, () => socket.destroy(new Error('API connection timed out.')));
socket.on('end', () => {
  const status = response.split('\r\n')[0];
  if (!/^HTTP\/1\.[01] \d{3}/.test(status)) { console.error('No valid HTTP response.'); process.exitCode = 1; return; }
  console.log(status);
  console.log('Credential-free API reachability test complete; no login or configuration changes requested.');
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
