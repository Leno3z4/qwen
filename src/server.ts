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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(raw) > 32_768) throw new Error('Request too large');
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
    return (separator >= 0 ? decoded.slice(separator + 1) : '') === dashboardPassword;
  } catch {
    return false;
  }
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Basic realm="Qwen Agent Dashboard"' });
  res.end(JSON.stringify({ error: 'Dashboard authentication required' }));
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Qwen Trading Agent</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf3;background:#090b0f;--panel:#12161c;--panel2:#0e1217;--line:#252d37;--muted:#8994a1;--text:#edf2f7;--good:#72e39a;--warn:#f5c769;--bad:#ff7d7d;--accent:#9dc5ff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 700px at 20% -10%,#172033 0,#090b0f 55%);min-height:100vh}.wrap{max-width:1220px;margin:auto;padding:26px 20px 60px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:22px}.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#798493}.title{font-size:34px;font-weight:760;margin-top:4px}.sub{color:var(--muted);margin-top:5px}.status{display:flex;gap:9px;align-items:center;border:1px solid var(--line);background:#11161c;padding:8px 11px;border-radius:999px;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:#77818d}.dot.on{background:var(--good);box-shadow:0 0 12px #72e39a55}.dot.busy{background:var(--warn);box-shadow:0 0 12px #f5c76955}.grid{display:grid;grid-template-columns:1.55fr .85fr;gap:16px}.card{background:linear-gradient(180deg,#141920,#101419);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 14px 40px #0003}.card h2{font-size:16px;margin:0}.head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:13px}.muted{color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.stat{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:13px}.label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.value{font-size:17px;margin-top:6px;font-weight:700;word-break:break-word}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.controls{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}button{border:1px solid #d9e3ee;background:#edf3f9;color:#10151b;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.05)}button:disabled{opacity:.5;cursor:not-allowed}button.secondary{background:#1b222b;color:#e7edf4;border-color:#303a46}button.danger{background:#3a1d22;color:#ffd7d7;border-color:#633038}.banner{display:none;border-radius:11px;padding:11px 13px;margin:0 0 16px;border:1px solid #623038;background:#24161a;color:#ffd8db;font-size:13px}.banner.show{display:block}.strategy{min-height:380px;width:100%;resize:vertical;background:#0a0e13;color:#eaf0f6;border:1px solid var(--line);border-radius:12px;padding:14px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}.strategy:focus{border-color:#4f6379}.hint{font-size:12px;color:var(--muted);margin-top:9px}.log{height:330px;overflow:auto;white-space:pre-wrap;background:#0a0e13;border:1px solid var(--line);border-radius:12px;padding:13px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.wide{grid-column:1/-1}.toolbar{display:flex;gap:8px;align-items:center}.toast{position:fixed;right:20px;bottom:20px;padding:12px 15px;border-radius:11px;background:#161d25;border:1px solid #35404d;box-shadow:0 12px 30px #0005;opacity:0;transform:translateY(8px);pointer-events:none;transition:.2s;font-size:13px}.toast.show{opacity:1;transform:none}.small{padding:8px 11px;font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.empty{color:#707b87;text-align:center;padding:28px 10px}@media(max-width:850px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.top{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div id="banner" class="banner"></div>
  <div class="top">
    <div><div class="eyebrow">Autonomous execution console</div><div class="title">Qwen Trading Agent</div><div class="sub">Qwen reasons · AgentHub2 authorizes · Perpl executes</div></div>
    <div class="status"><span id="dot" class="dot"></span><span id="statusText">Connecting…</span></div>
  </div>

  <div class="grid">
    <section class="card">
      <div class="head"><h2>Strategy</h2><div class="toolbar"><button id="reload" class="secondary small">Reload</button><button id="save" class="small">Save</button></div></div>
      <textarea id="strategy" class="strategy" spellcheck="false" placeholder="Loading strategy…"></textarea>
      <div class="hint">Saved strategy text is injected into Qwen's system context on every cycle.</div>
    </section>

    <section class="card">
      <div class="head"><h2>Control center</h2><button id="refresh" class="secondary small">Refresh</button></div>
      <div class="stats">
        <div class="stat"><div class="label">Loop</div><div id="loop" class="value">—</div></div>
        <div class="stat"><div class="label">Running</div><div id="running" class="value">—</div></div>
        <div class="stat"><div class="label">Last run</div><div id="last" class="value">—</div></div>
        <div class="stat"><div class="label">Errors</div><div id="error" class="value muted">None</div></div>
      </div>
      <div class="controls"><button id="run">Run one cycle</button><button id="toggle" class="secondary">Enable loop</button></div>
      <div class="hint">Manual runs are allowed even when the autonomous loop is disabled.</div>
    </section>

    <section class="card wide">
      <div class="head"><h2>Latest agent result</h2><span id="resultTime" class="muted mono">—</span></div>
      <div id="result" class="log"><div class="empty">No cycle has completed yet.</div></div>
    </section>

    <section class="card wide">
      <div class="head"><h2>Activity</h2><span class="muted">Auto-refresh every 3s</span></div>
      <div id="logs" class="log"><div class="empty">Loading activity…</div></div>
    </section>
  </div>
</div>
<div id="toast" class="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
let busy = false;
let strategyDirty = false;
function showToast(message){const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>t.classList.remove('show'),2200)}
function showError(message){const b=$('banner');b.textContent=message;b.classList.add('show')}
function clearError(){$('banner').classList.remove('show')}
async function api(path, options={}){const response=await fetch(path,{...options,headers:{...(options.headers||{}),'content-type':'application/json'}});const text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={error:text||('HTTP '+response.status)}}if(!response.ok)throw new Error(data.error||('HTTP '+response.status));return data}
function renderStatus(st){
  const active=st.running; $('dot').className='dot '+(active?'busy':st.enabled?'on':''); $('statusText').textContent=active?'Cycle running…':st.enabled?'Autonomous loop enabled':'Autonomous loop disabled';
  $('loop').textContent=st.enabled?'Enabled':'Disabled'; $('loop').className='value '+(st.enabled?'good':'muted'); $('running').textContent=st.running?'Yes':'No'; $('running').className='value '+(st.running?'warn':'muted');
  $('last').textContent=st.lastRunAt?new Date(st.lastRunAt).toLocaleString():'Never';
  $('error').textContent=st.lastError||'None'; $('error').className='value '+(st.lastError?'bad':'good');
  $('toggle').textContent=st.enabled?'Disable loop':'Enable loop'; $('run').disabled=st.running; $('toggle').disabled=st.running;
  $('result').textContent=st.lastResult||''; if(!st.lastResult)$('result').innerHTML='<div class="empty">No cycle has completed yet.</div>'; $('resultTime').textContent=st.lastRunAt?new Date(st.lastRunAt).toLocaleTimeString():'—';
  const logs=st.logs||[]; $('logs').textContent=logs.length?logs.join('\\n\\n'):'No activity yet.';
}
async function refresh(){const [strategy,status]=await Promise.all([api('/api/strategy'),api('/api/status')]);if(!strategyDirty && document.activeElement !== $('strategy')) $('strategy').value=strategy.strategy;renderStatus(status);clearError()}
$('strategy').addEventListener('input',()=>{strategyDirty=true});
$('refresh').onclick=async()=>{try{await refresh();showToast('Dashboard refreshed')}catch(e){showError(e.message)}};
$('reload').onclick=async()=>{try{const d=await api('/api/strategy');$('strategy').value=d.strategy;strategyDirty=false;showToast('Strategy reloaded')}catch(e){showError(e.message)}};
$('save').onclick=async()=>{try{await api('/api/strategy',{method:'POST',body:JSON.stringify({strategy:$('strategy').value})});strategyDirty=false;showToast('Strategy saved');await refresh()}catch(e){showError(e.message)}};
$('run').onclick=async()=>{try{busy=true;$('run').textContent='Running…';clearError();await api('/api/run',{method:'POST',body:'{}'});showToast('Cycle completed');await refresh()}catch(e){showError(e.message)}finally{busy=false;$('run').textContent='Run one cycle';await refresh().catch(()=>{})}};
$('toggle').onclick=async()=>{try{const st=await api('/api/status');await api('/api/control',{method:'POST',body:JSON.stringify({enabled:!st.enabled})});showToast(!st.enabled?'Autonomous loop enabled':'Autonomous loop disabled');await refresh()}catch(e){showError(e.message)}};
refresh().catch(e=>showError(e.message));setInterval(()=>refresh().catch(()=>{}),3000);
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
