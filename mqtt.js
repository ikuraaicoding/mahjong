/* NomiMQTT: 最小の MQTT 3.1.1 クライアント(WebSocket経由・QoS0のみ)
 * 外部ライブラリを増やさないために自前で実装。CONNECT / SUBSCRIBE / PUBLISH / PING だけ。
 */
(function(){
'use strict';
const TE = new TextEncoder(), TD = new TextDecoder();

function remLen(n){
  const out = [];
  do{ let b = n % 128; n = Math.floor(n / 128); if(n > 0) b |= 128; out.push(b); }while(n > 0);
  return out;
}
function utf(s){ const b = TE.encode(s); const o = new Uint8Array(2 + b.length); o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2); return o; }
function cat(parts){
  let n = 0; parts.forEach(p => { n += p.length; });
  const o = new Uint8Array(n); let k = 0; parts.forEach(p => { o.set(p, k); k += p.length; });
  return o;
}
function packet(first, body){ return cat([Uint8Array.of(first), Uint8Array.from(remLen(body.length)), body]); }

class MQ {
  constructor(url, h){
    this.url = url; this.h = h || {};
    this.ws = null; this.ok = false; this.buf = new Uint8Array(0);
    this.ping = null; this.topics = []; this.pid = 1; this.closedByUs = false;
    this.id = 'nomi' + Array.from(crypto.getRandomValues(new Uint8Array(6))).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  open(){
    this.closedByUs = false;
    let ws;
    try{ ws = this.ws = new WebSocket(this.url, 'mqtt'); }catch(e){ if(this.h.onClose) this.h.onClose(this); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const vh = cat([utf('MQTT'), Uint8Array.of(4, 0x02, 0, 30)]);      // level4, clean session, keepalive 30s
      ws.send(packet(0x10, cat([vh, utf(this.id)])));
    };
    ws.onmessage = e => this.feed(new Uint8Array(e.data));
    ws.onclose = () => { this.ok = false; clearInterval(this.ping); if(this.h.onClose && !this.closedByUs) this.h.onClose(this); };
    ws.onerror = () => {};
  }
  feed(chunk){
    this.buf = cat([this.buf, chunk]);
    for(;;){
      const b = this.buf;
      if(b.length < 2) return;
      let mul = 1, len = 0, i = 1, d;
      do{
        if(i >= b.length) return;
        d = b[i++]; len += (d & 127) * mul; mul *= 128;
        if(mul > 128 * 128 * 128 * 128) { this.close(); return; }
      }while(d & 128);
      if(b.length < i + len) return;
      const type = b[0] >> 4, flags = b[0] & 15, body = b.subarray(i, i + len);
      this.buf = b.slice(i + len);
      this.handle(type, flags, body);
    }
  }
  handle(type, flags, body){
    if(type === 2){                                   // CONNACK
      if(body[1] === 0){
        this.ok = true;
        this.topics.forEach(t => this.sendSub(t));
        clearInterval(this.ping);
        this.ping = setInterval(() => { try{ this.ws.send(Uint8Array.of(0xC0, 0)); }catch(e){} }, 20000);
        if(this.h.onOpen) this.h.onOpen(this);
      }else this.close();
    }else if(type === 3){                             // PUBLISH
      const tl = (body[0] << 8) | body[1];
      const topic = TD.decode(body.subarray(2, 2 + tl));
      let off = 2 + tl;
      if((flags >> 1) & 3) off += 2;
      if(this.h.onMessage) this.h.onMessage(topic, body.subarray(off), this);
    }
  }
  sendSub(topic){
    const id = this.pid++; if(this.pid > 65000) this.pid = 1;
    try{ this.ws.send(packet(0x82, cat([Uint8Array.of(id >> 8, id & 255), utf(topic), Uint8Array.of(0)]))); }catch(e){}
  }
  subscribe(topic){
    if(!this.topics.includes(topic)) this.topics.push(topic);
    if(this.ok) this.sendSub(topic);
  }
  publish(topic, text){
    if(!this.ok) return false;
    try{ this.ws.send(packet(0x30, cat([utf(topic), TE.encode(text)]))); return true; }catch(e){ return false; }
  }
  close(){
    this.closedByUs = true; clearInterval(this.ping); this.ok = false;
    try{ this.ws.send(Uint8Array.of(0xE0, 0)); }catch(e){}
    try{ this.ws.close(); }catch(e){}
  }
}
window.NomiMQTT = { MQ, BROKERS: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'] };
})();
