/**
 * 纽澳跨境采购与快递追踪管家 V7.1 - Cloudflare Pages Function (方案B)
 * 文件路径: functions/api/sync.js
 * 对应接口: /api/sync
 *
 * 需要在 Cloudflare Pages -> Settings -> Functions -> KV namespace bindings 绑定:
 *   Variable name (变量名): NZ_TRACKER_KV (同时支持自动识别任意已绑定的 KV 变量名)
 *
 * 可选在 Settings -> Environment variables 绑定:
 *   Variable name (变量名): SYNC_PASSCODE (例如 nz2026)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Passcode',
  'Content-Type': 'application/json; charset=utf-8'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function getKvNamespace(env) {
  if (!env || typeof env !== 'object') return null;
  if (env.NZ_TRACKER_KV && typeof env.NZ_TRACKER_KV.get === 'function') return env.NZ_TRACKER_KV;
  for (const key of Object.keys(env)) {
    const binding = env[key];
    if (binding && typeof binding === 'object' && typeof binding.get === 'function' && typeof binding.put === 'function') {
      return binding;
    }
  }
  return null;
}

function checkAuth(request, env) {
  const requiredPass = String((env && (env.SYNC_PASSCODE || env.PASSCODE)) || '').trim();
  if (!requiredPass) return true;
  const url = new URL(request.url);
  const provided = String(request.headers.get('X-Sync-Passcode') || url.searchParams.get('passcode') || '').trim();
  return provided === requiredPass;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'pull';

  // 1. Live Exchange Rate Endpoint (NZD/CNY & AUD/CNY)
  if (action === 'rate') {
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/NZD');
      const data = await res.json();
      const nzdToCny = data && data.rates && data.rates.CNY ? Number(data.rates.CNY.toFixed(4)) : 4.35;
      const nzdToAud = data && data.rates && data.rates.AUD ? Number(data.rates.AUD) : 0.92;
      const audToCny = Number((nzdToCny / nzdToAud).toFixed(4));
      return new Response(JSON.stringify({
        ok: true,
        NZD: nzdToCny,
        AUD: audToCny,
        updatedAt: new Date().toISOString()
      }), { headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: true,
        NZD: 4.35,
        AUD: 4.72,
        fallback: true
      }), { headers: CORS_HEADERS });
    }
  }

  const kv = getKvNamespace(env);
  if (!kv) {
    return new Response(JSON.stringify({
      ok: false,
      error: '尚未在 Cloudflare Pages 绑定 KV 命名空间 (请在 Settings -> Functions -> KV namespace bindings 绑定 NZ_TRACKER_KV 并重新部署一次)'
    }), { status: 500, headers: CORS_HEADERS });
  }

  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({
      ok: false,
      error: '云端同步口令 (SYNC_PASSCODE) 校验未通过，请检查输入的同步密码'
    }), { status: 401, headers: CORS_HEADERS });
  }

  // 2. Snapshots History List (Cloud Time Machine)
  if (action === 'snapshots') {
    const rawHist = await kv.get('nz_tracker_snapshots_v7');
    const snapshots = rawHist ? JSON.parse(rawHist) : [];
    const summaryList = snapshots.map(s => ({
      id: s.id,
      savedAt: s.savedAt,
      note: s.note,
      orderCount: s.orderCount,
      productCount: s.productCount
    }));
    return new Response(JSON.stringify({ ok: true, snapshots: summaryList }), { headers: CORS_HEADERS });
  }

  // 3. Restore Specific Snapshot by ID
  if (action === 'snapshot_get') {
    const snapId = url.searchParams.get('id');
    const rawHist = await kv.get('nz_tracker_snapshots_v7');
    const snapshots = rawHist ? JSON.parse(rawHist) : [];
    const found = snapshots.find(s => s.id === snapId);
    if (!found) {
      return new Response(JSON.stringify({ ok: false, error: '未找到对应的历史快照' }), { status: 404, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ ok: true, snapshot: found }), { headers: CORS_HEADERS });
  }

  // 4. Default: Pull Latest Full System State
  const latestRaw = await kv.get('nz_tracker_latest_v7');
  if (!latestRaw) {
    return new Response(JSON.stringify({ ok: true, empty: true, data: null }), { headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify({
    ok: true,
    empty: false,
    data: JSON.parse(latestRaw)
  }), { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = getKvNamespace(env);
  if (!kv) {
    return new Response(JSON.stringify({
      ok: false,
      error: '尚未绑定 NZ_TRACKER_KV 命名空间 (请在 Settings -> Functions -> KV 绑定并重新部署一次)'
    }), { status: 500, headers: CORS_HEADERS });
  }
  if (!checkAuth(request, env)) {
    return new Response(JSON.stringify({
      ok: false,
      error: '云端同步口令校验失败，请检查输入的同步密码'
    }), { status: 401, headers: CORS_HEADERS });
  }

  const body = await request.json();
  const payload = body.data || body;
  const note = body.note || '常规云同步保存';
  const nowIso = new Date().toISOString();
  payload._cfSavedAt = nowIso;

  await kv.put('nz_tracker_latest_v7', JSON.stringify(payload));

  // Maintain rolling 15 snapshots in KV for Cloud Time Machine
  const rawHist = await kv.get('nz_tracker_snapshots_v7');
  const snapshots = rawHist ? JSON.parse(rawHist) : [];
  const snapEntry = {
    id: 'SNAP-' + Date.now(),
    savedAt: nowIso,
    note,
    orderCount: Array.isArray(payload.orders) ? payload.orders.length : 0,
    productCount: Array.isArray(payload.products) ? payload.products.length : 0,
    data: payload
  };
  snapshots.unshift(snapEntry);
  if (snapshots.length > 15) snapshots.length = 15;
  await kv.put('nz_tracker_snapshots_v7', JSON.stringify(snapshots));

  return new Response(JSON.stringify({
    ok: true,
    savedAt: nowIso,
    snapshotId: snapEntry.id,
    orderCount: snapEntry.orderCount,
    snapshotCount: snapshots.length
  }), { headers: CORS_HEADERS });
}
