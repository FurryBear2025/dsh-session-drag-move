const https = require('https');
const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) { console.log('NO_TOKEN'); process.exit(0); }
function api(path, method, body){
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({host:'api.github.com', path, method: method||'GET',
      headers:{'User-Agent':'dsh-publish','Accept':'application/vnd.github+json','Authorization':'Bearer '+TOKEN,
        ...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},
      r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ let j=null; try{j=JSON.parse(d);}catch(e){}
        res({status:r.statusCode, body:j||d}); }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}
(async()=>{
  const me = await api('/user');
  console.log('auth:', me.status, me.body && me.body.login);
  const repo = await api('/repos/FurryBear2025/dsh-session-drag-move');
  console.log('repo:', repo.status, repo.body && repo.body.full_name, 'created:', repo.body && repo.body.created_at, 'topics:', JSON.stringify(repo.body && repo.body.topics));
})().catch(e=>console.log('ERR', e.message));