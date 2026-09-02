import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadStrategy, saveStrategy } from './strategy.js';

export type AgentStatus = {
  running: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  logs: string[];
};

type CycleRunner = () => Promise<void>;

const dashboardPassword = process.env.DASHBOARD_PASSWORD;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 32_768) throw new Error('Request too large');
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON');
  return parsed as Record<string, unknown>;
}

function authorized(req: IncomingMessage): boolean {
  if (!dashboardPassword) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    return password === dashboardPassword;
  } catch {
    return false;
  }
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Basic realm="Qwen Agent Dashboard"',
  });
  res.end(JSON.stringify({ error: 'Dashboard authentication required' }));
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Qwen Trading Agent</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0d10;color:#f5f7fa}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0b0d10,#11151a);min-height:100vh}
main{max-width:1100px;margin:0 auto;padding:32px 20px 60px}.top{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:24px}.eyebrow{color:#8d96a3;font-size:12px;text-transform:uppercase;letter-spacing:.14em}.title{font-size:34px;font-weight:700;margin:6px 0}.sub{color:#9ea7b3}.grid{display:grid;grid-template-columns:1.3fr .7fr;gap:18px}.card{background:#151a20;border:1px solid #29313a;border-radius:16px;padding:18px;box-shadow:0 10px 30px #0003}.card h2{margin:0 0 12px;font-size:17px}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.stat{padding:14px;border:1px solid #28303a;border-radius:12px;background:#11151a}.label{font-size:12px;color:#88919d}.value{margin-top:5px;font-size:18px;font-weight:650}.ok{color:#8fe38f}.bad{color:#ff8888}.muted{color:#919aa7}textarea{width:100%;min-height:420px;resize:vertical;background:#0d1116;color:#edf1f5;border:1px solid #303842;border-radius:12px;padding:14px;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}textarea:focus{border-color:#66717e}button{appearance:none;border:0;border-radius:10px;padding:10px 14px;background:#f2f4f7;color:#11151a;font-weight:650;cursor:pointer}button.secondary{background:#252c34;color:#eef2f6;border:1px solid #343d48}button.danger{background:#5b2424;color:#ffd7d7}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.log{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;max-height:420px;overflow:auto;background:#0d1116;border-radius:12px;padding:12px;border:1px solid #28303a}.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 9px;border-radius:999px;background:#1c232b;border:1px solid #2f3741;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:#888}.dot.on{background:#79d779}.notice{margin-top:14px;color:#a7b0bb;font-size:12px}.wide{grid-column:1/-1}@media(max-width:800px){.grid{grid-template-columns:1fr}.top{align-items:start;flex-direction:column}.wide{grid-column:auto}}
</style>
</head>
<body>
<main>
  <div class="top">
    <div><div class="eyebrow">Autonomous agent</div><div class="title">Qwen Trading Agent</div><div class="sub">Qwen decides. AgentHub2 executes on Perpl.</div></div>
    <div class="pill"><span id="dot" class="dot"></span><span id="enabled">Loading…</span></div>
  </div>
  <div class="grid">
    <section class="card">
      <h2>Strategy instructions</h2>
      <textarea id="strategy" spellcheck="false"></textarea>
      <div class="actions"><button id="save">Save strategy</button><button class="secondary" id="reload">Reload</button></div>
      <div class="notice">These instructions are injected into Qwen's system context on every trading cycle.</div>
    </section>
    <section class="card">
      <h2>Agent controls</h2>
      <div class="stats">
        <div class="stat"><div class="label">Loop</div><div class="value" id="loop">—</div></div>
        <div class="stat"><div class="label">Last run</div><div class="value" id="last">—</div></div>
        <div class="stat"><div class="label">Result</div><div class="value" id="result">—</div></div>
        <div class="stat"><div class="label">Error</div><div class="value" id="error">—</div></div>
      </div>
      <div class="actions"><button id="run">Run one cycle</button><button class="secondary" id="toggle">Disable loop</button></div>
    </section>
    <section class="card wide">
      <h2>Recent activity</h2>
      <div id="logs" class="log">Loading…</div>
    </section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
async function api(path, options){const r=await fetch(path,{headers:{'content-type':'application/json'},...options});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
async function refresh(){const [s,st]=await Promise.all([api('/api/strategy'),api('/api/status')]);$('strategy').value=s.strategy;$('enabled').textContent=st.enabled?'Autonomous loop enabled':'Autonomous loop disabled';$('dot').className='dot '+(st.enabled?'on':'');$('loop').textContent=st.enabled?'enabled':'disabled';$('last').textContent=st.lastRunAt?new Date(st.lastRunAt).toLocaleString():'—';$('result').textContent=st.lastResult||'—';$('error').textContent=st.lastError||'—';$('error').className='value '+(st.lastError?'bad':'muted');$('toggle').textContent=st.enabled?'Disable loop':'Enable loop';$('logs').textContent=(st.logs||[]).join('\n\n')||'No activity yet.'}
$('save').onclick=async()=>{try{await api('/api/strategy',{method:'POST',body:JSON.stringify({strategy:$('strategy').value})});await refresh();$('save').textContent='Saved';setTimeout(()=>$('save').textContent='Save strategy',1200)}catch(e){alert(e.message)}};
$('reload').onclick=()=>refresh().catch(e=>alert(e.message));
$('run').onclick=async()=>{try{$('run').disabled=true;$('run').textContent='Running…';await api('/api/run',{method:'POST',body:'{}'});await refresh()}catch(e){alert(e.message)}finally{$('run').disabled=false;$('run').textContent='Run one cycle'}};
$('toggle').onclick=async()=>{try{const st=await api('/api/status');await api('/api/control',{method:'POST',body:JSON.stringify({enabled:!st.enabled})});await refresh()}catch(e){alert(e.message)}};
refresh().catch(e=>{$('logs').textContent=e.message});setInterval(()=>refresh().catch(()=>{}),5000);
</script>
</body>
</html>`;

export function startDashboard(runCycle: CycleRunner, getStatus: () => AgentStatus, setEnabled: (enabled: boolean) => void) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer(async (req, res) => {
    if (req.url === '/health') return json(res, 200, { ok: true });
    if (!authorized(req)) return unauthorized(res);
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && req.url === '/api/strategy') return json(res, 200, { strategy: await loadStrategy() });
      if (req.method === 'POST' && req.url === '/api/strategy') {
        const data = await body(req); const strategy = String(data.strategy ?? '').trim();
        if (!strategy) return json(res, 400, { error: 'Strategy cannot be empty' });
        await saveStrategy(strategy); return json(res, 200, { saved: true });
      }
      if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, getStatus());
      if (req.method === 'POST' && req.url === '/api/run') { await runCycle(); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && req.url === '/api/control') {
        const data = await body(req); setEnabled(Boolean(data.enabled)); return json(res, 200, { enabled: Boolean(data.enabled) });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(port, '0.0.0.0', () => console.log(`Qwen dashboard listening on ${port}`));
}
