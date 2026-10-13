const https = require('https');
const T = process.env.GH_TOKEN;
function api(p){return new Promise((res,rej)=>{const r=https.request({host:'api.github.com',path:p,method:'GET',headers:{'user-agent':'dsh','accept':'application/vnd.github+json','authorization':'Bearer '+T}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{let j;try{j=JSON.parse(d)}catch{j=d}res({s:x.statusCode,b:j})})});r.on('error',rej);r.end()})}
(async()=>{
  const me = await api('/user');
  console.log('user:', me.s, me.b && me.b.login);
  if (me.s !== 200) { console.log('scopes header may be missing; body:', JSON.stringify(me.b).slice(0,200)); }
  const r1 = await api('/repos/FurryBear2025/dsh-session-drag-move');
  console.log('own repo:', r1.s, r1.b && r1.b.full_name);
  const r2 = await api('/repos/awesome-dsh-plugin/awesome-dsh-plugin');
  console.log('target repo:', r2.s, r2.b && r2.b.full_name);
  // permission check for pushing
  console.log('push perm on own repo:', r1.b && r1.b.permissions && r1.b.permissions.push);
})().catch(e=>console.log('ERR', e.message));