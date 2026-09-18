const dgram = require('node:dgram');
const EPOCH = 2208988800;
function stamp(buffer, offset, ms) {
  const seconds = ms / 1000 + EPOCH;
  buffer.writeUInt32BE(Math.floor(seconds) >>> 0, offset);
  buffer.writeUInt32BE(Math.floor((seconds % 1) * 4294967296) >>> 0, offset + 4);
}
function readStamp(buffer, offset) {
  return (buffer.readUInt32BE(offset) - EPOCH + buffer.readUInt32BE(offset + 4) / 4294967296) * 1000;
}
function decode(reply, request, start, end) {
  if (reply.length < 48 || (reply[0] & 7) !== 4 || (reply[0] >> 6) === 3 || reply[1] < 1 || reply[1] > 15)
    throw Error('Invalid NTP response');
  if (!reply.subarray(24,32).equals(request.subarray(40,48))) throw Error('NTP request mismatch');
  const received = readStamp(reply,32), sent = readStamp(reply,40);
  if (!Number.isFinite(sent) || sent < Date.UTC(2020,0,1) || sent < received || end-start > 5000) throw Error('Invalid NTP timestamp');
  return ((received-start)+(sent-end))/2;
}
function query(host) {
  return new Promise((resolve,reject) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (error,value) => { if(done)return;done=true;clearTimeout(timer);socket.close();error?reject(error):resolve(value); };
    const timer = setTimeout(()=>finish(Error('NTP timeout')),3500);
    socket.on('error',error=>finish(error));
    socket.connect(123,host,()=>{
      const request = Buffer.alloc(48); request[0] = 0x23;
      const start = Date.now(); stamp(request,40,start);
      socket.once('message',reply=>{
        try { const end=Date.now();finish(null,{now:end+decode(reply,request,start,end),host}); }
        catch(error){finish(error);}
      });
      socket.send(request,error=>{if(error)finish(error);});
    });
  });
}
function installNetworkTime(app) {
  let sample=null, syncing=false;
  async function sync() {
    if(syncing)return;syncing=true;
    try {
      for(const host of ['time.cloudflare.com','time.google.com']) {
        try { const result=await query(host);sample={...result,monotonic:process.hrtime.bigint(),syncedAt:new Date(result.now).toISOString()};break; } catch {}
      }
    } finally {syncing=false;}
  }
  app.get('/api/time',(_req,res)=>{
    const age=sample?Number(process.hrtime.bigint()-sample.monotonic)/1e6:Infinity;
    const fresh=age<7200000;
    res.set('Cache-Control','no-store').json({now:fresh?sample.now+age:Date.now(),timezone:'Asia/Kolkata',
      source:fresh?'ntp':'server-fallback',server:fresh?sample.host:null,lastSync:sample?.syncedAt||null});
  });
  sync();setInterval(sync,3600000).unref();
}
module.exports={installNetworkTime,decode,stamp};
