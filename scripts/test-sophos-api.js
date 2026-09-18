'use strict';
const tls = require('node:tls');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const previewMode = process.argv.includes('--preview');
const log = (...args) => { if (!previewMode) console.log(...args); };
const PIN = 'BF:B2:D7:E6:32:0E:65:24:EB:E4:5A:46:14:44:A4:60:29:60:F9:AD:2F:C1:C7:98:CC:99:92:76:1D:78:CE:B6';
const escapeXML = value => value.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));

function verifyPeer(cert, ca, expected = PIN) {
  if (cert.fingerprint256 !== expected) throw Error('Certificate fingerprint changed. No credentials sent.');
  if (!ca.ca || !cert.verify(ca.publicKey)) throw Error('CA signature verification failed.');
  for (const item of [ca, cert]) {
    if (!(Date.now() >= Date.parse(item.validFrom) && Date.now() <= Date.parse(item.validTo))) throw Error('Certificate is outside its validity period.');
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if(input.length > 16384) throw Error('Input too large.'); }
  const credentials = JSON.parse(input.replace(/^\uFEFF/, ''));
  input = '';
  if (credentials.username !== 'iptracker_sync' || typeof credentials.password !== 'string' || !credentials.password) throw Error('Username or password is missing.');
  const ca = new X509Certificate(fs.readFileSync(path.join(__dirname, '../config/sophos-ca.pem')));
  const body = new URLSearchParams({reqxml: `<Request><Login><Username>${escapeXML(credentials.username)}</Username><Password>${escapeXML(credentials.password)}</Password></Login><Get><DHCPServer></DHCPServer></Get></Request>`}).toString();
  credentials.password = '';
  const agent = new http.Agent({keepAlive:false});
  // http handles framing; only our verified TLS socket transports the request.
  agent.createConnection = (_options, callback) => {
    let delivered = false;
    const complete = (error, socket) => { if (!delivered) { delivered = true; callback(error, socket); } };
    const socket = tls.connect({host:'192.168.1.1',port:4444,rejectUnauthorized:false}, () => {
      try {
        verifyPeer(new X509Certificate(socket.getPeerCertificate().raw), ca);
        log('Pinned certificate and CA verified. Sending read-only DHCP request.');
        complete(null, socket);
      } catch(error) { complete(error); socket.destroy(); }
    });
    socket.setTimeout(15000, () => socket.destroy(Error('Connection timed out.')));
    socket.on('error', error => complete(error));
    // Never return an unverified socket to the HTTP client.
  };
  try {
    await new Promise((resolve,reject) => {
      const request = http.request({host:'192.168.1.1',port:4444,path:'/webconsole/APIController',method:'POST',agent,
        headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}}, response => {
        let xml = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { xml += chunk; if(xml.length > 8*1024*1024) response.destroy(Error('Response too large.')); });
        response.on('error',reject);
        response.on('end', () => {
          log(`HTTP status: ${response.statusCode}`);
          const auth = /<Login\b[^>]*>[\s\S]*?<status\b[^>]*>([\s\S]*?)<\/status>/i.exec(xml);
          const authOK = auth && /^\s*Authentication Successful\.?\s*$/i.test(auth[1]);
          if (!authOK) { reject(Error('Authentication was not confirmed. Check account credentials, login restrictions and API access.')); return; }
          log('Authentication successful.');
          const servers = xml.match(/<DHCPServer\b[^>]*>[\s\S]*?<\/DHCPServer>/gi) || [];
          const configurations = servers.filter(s => /<Name\b[^>]*>/.test(s));
          if (!configurations.length) {
            const codes = [...xml.matchAll(/<Status\b[^>]*code=["'](\d+)["']/gi)].map(m=>m[1]);
            log(`No DHCP configurations returned. API status codes: ${codes.join(', ') || 'none'}`);
            reject(Error('DHCP read access or response format needs checking. Do not increase permissions yet.')); return;
          }
          const leases = configurations.flatMap(s => s.match(/<StaticLease\b[^>]*>[\s\S]*?<\/StaticLease>/gi) || []);
          const count = leases.reduce((sum,s)=>sum+(s.match(/<Lease\b/g)||[]).length,0);
          log(`SUCCESS: ${configurations.length} DHCP configurations; ${count} static IP-MAC reservations.`);
          log('No configuration changed. Password and response were not saved.');
          if (previewMode) process.stdout.write(JSON.stringify({xml}));
          resolve();
        });
      });
      request.on('error',reject);
      request.setTimeout(20000,()=>request.destroy(Error('Request timed out.')));
      request.end(body);
    });
  } finally { agent.destroy(); }
}
if (require.main === module) main().catch(error=>{ console.error(`TEST FAILED: ${error.message}`); process.exitCode=1; });
module.exports = { verifyPeer, escapeXML };
