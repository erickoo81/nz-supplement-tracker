/**
 * Cloudflare Pages Function: functions/api/remind.js
 * 直接放进你现有的 GitHub 仓库 nz-supplement-tracker 的 functions/api/ 目录下即可！
 * 无需新建 Worker，直接复用现有 Pages 项目绑定的 NZ_TRACKER_KV。
 *
 * 在 Cloudflare Pages (nz-supplement-tracker -> Settings -> Environment variables) 添加 2 个变量即可：
 *   1. RESEND_API_KEY : Resend 密钥 (re_xxxx)
 *   2. ALERT_EMAIL    : 接收提醒的邮箱（未绑域名时填注册 Resend 的邮箱）
 *   （可选）FROM_EMAIL : 发件人邮箱，不填默认使用 onboarding@resend.dev
 *   （可选）APP_URL    : 你的网站地址，不填自动使用当前访问域名
 *
 * 定时触发：在 cron-job.org 新建每日任务，时区选 Pacific/Auckland（如每天 09:00 或 10:00），
 * URL 填：https://nz-supplement-tracker.pages.dev/api/remind
 * 手动测试：浏览器直接访问 https://nz-supplement-tracker.pages.dev/api/remind?force=1
 */

function getNzTodayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function getKvBinding(env) {
  if (env.NZ_TRACKER_KV && typeof env.NZ_TRACKER_KV.get === 'function') return env.NZ_TRACKER_KV;
  for (const k of Object.keys(env || {})) {
    if (env[k] && typeof env[k].get === 'function') return env[k];
  }
  return null;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getOrderStatus(o) {
  const parcels = Array.isArray(o.parcels) ? o.parcels : [];
  if (parcels.length === 0) return 'PENDING';
  const deliv = parcels.filter(p => p && String(p.deliveredDate || '').trim()).length;
  if (deliv === parcels.length) return 'DELIVERED';
  return deliv > 0 ? 'PARTIAL' : 'IN_TRANSIT';
}

function isFriendDaigou(o) {
  const rec = String(o.recipient || '').trim();
  return Boolean(rec && rec !== 'HOME' && rec !== '自用');
}

function collectAlerts(data, todayStr) {
  const cfg = Object.assign(
    { transitOverdueDays: 14, missingTrackDays: 3, expiryWarnDays: 60, snoozedUntil: {}, dismissedIds: {}, customReminders: [] },
    data.reminderConfig || {}
  );
  const todayMs = new Date(todayStr + 'T00:00:00Z').getTime();
  const dayMs = 86400000;
  const alerts = [];

  const orders = (Array.isArray(data.orders) ? data.orders : []).filter(o => o && !o.cancelled);

  // 1. 物流缺运单 / 在途超时 / 拆单掉队
  for (const o of orders) {
    const st = getOrderStatus(o);
    const isSelf = o.recipient === '自用' || o.merchant === 'CW';
    if (isSelf || st === 'DELIVERED') continue;

    const ordMs = o.orderDate ? new Date(o.orderDate + 'T00:00:00Z').getTime() : NaN;
    const daysSince = isNaN(ordMs) ? 0 : Math.floor((todayMs - ordMs) / dayMs);
    const parcels = Array.isArray(o.parcels) ? o.parcels : [];
    const hasMissingTrack = parcels.length === 0 || parcels.some(p => !String(p.trackingNo || '').trim());

    if (hasMissingTrack && daysSince >= cfg.missingTrackDays) {
      alerts.push({
        id: `rem_notrack_${o.id}`,
        level: daysSince >= 7 ? '高优' : '关注',
        icon: '📭',
        title: `缺运单催录：${o.recipient || '未知'} · ${o.merchant || ''}（下单已 ${daysSince} 天）`,
        detail: `订单号 ${o.orderNo || o.id}（${o.orderDate || ''}）尚未补全快递单号`
      });
    } else if (daysSince >= cfg.transitOverdueDays) {
      const tracks = parcels.map(p => p.trackingNo).filter(Boolean).join(', ');
      alerts.push({
        id: `rem_overdue_${o.id}`,
        level: daysSince >= cfg.transitOverdueDays + 7 ? '高优' : '关注',
        icon: '🚚',
        title: `在途超时 ${daysSince} 天：${o.recipient || '未知'} · ${o.merchant || ''}`,
        detail: `下单日 ${o.orderDate || ''}，运单号：${tracks || '未填'}`
      });
    }

    if (parcels.length > 1) {
      const delivDates = parcels.map(p => p.deliveredDate).filter(Boolean).sort();
      const undelivCnt = parcels.filter(p => !p.deliveredDate).length;
      if (delivDates.length > 0 && undelivCnt > 0) {
        const lagDays = Math.floor((todayMs - new Date(delivDates[0] + 'T00:00:00Z').getTime()) / dayMs);
        if (lagDays >= 5) {
          alerts.push({
            id: `rem_splitlag_${o.id}`,
            level: '高优',
            icon: '⚠️',
            title: `拆单掉队预警：${o.recipient || ''} 仍有 ${undelivCnt}/${parcels.length} 包未签收`,
            detail: `首包已于 ${delivDates[0]} 签收（已间隔 ${lagDays} 天）`
          });
        }
      }
    }
  }

  // 2. 2026+ 朋友代购待结算
  const daigouMap = {};
  for (const o of orders) {
    const yr = Number(o.year) || parseInt(String(o.orderDate || '').slice(0, 4), 10) || 0;
    if (yr < 2026 || !isFriendDaigou(o) || o.paymentSettled) continue;
    const rec = o.recipient;
    if (!daigouMap[rec]) daigouMap[rec] = { count: 0, delivered: 0 };
    daigouMap[rec].count++;
    if (getOrderStatus(o) === 'DELIVERED') daigouMap[rec].delivered++;
  }
  for (const [rec, info] of Object.entries(daigouMap)) {
    alerts.push({
      id: `rem_daigou_${rec}`,
      level: info.delivered > 0 ? '高优' : '关注',
      icon: '💰',
      title: `代购待结算：${rec}（${info.count} 单未结，${info.delivered} 单已签收）`,
      detail: '可在系统「统计与对账单」中一键生成微信结算清单'
    });
  }

  // 3. 保质期临期提醒
  const expMap = data.productExpiryDates || {};
  for (const [prod, expDate] of Object.entries(expMap)) {
    if (!expDate) continue;
    const daysLeft = Math.floor((new Date(expDate + 'T00:00:00Z').getTime() - todayMs) / dayMs);
    if (daysLeft <= cfg.expiryWarnDays) {
      alerts.push({
        id: `rem_exp_${prod}_${expDate}`,
        level: daysLeft <= 14 ? '高优' : '关注',
        icon: '💊',
        title: daysLeft < 0 ? `已过期 ${Math.abs(daysLeft)} 天：${prod}` : `保质期临期（剩 ${daysLeft} 天）：${prod}`,
        detail: `登记效期至 ${expDate}`
      });
    }
  }

  // 4. 自定义备忘（已逾期 / 今日到期 / 未来 3 天内到期）
  for (const cr of (cfg.customReminders || [])) {
    if (!cr || cr.done) continue;
    const dStr = cr.dueDate || todayStr;
    const diffDays = Math.floor((new Date(dStr + 'T00:00:00Z').getTime() - todayMs) / dayMs);
    if (diffDays <= 3) {
      alerts.push({
        id: cr.id,
        level: diffDays <= 0 ? '高优' : '关注',
        icon: '📌',
        title: cr.title,
        detail: diffDays < 0 ? `已逾期 ${Math.abs(diffDays)} 天（计划日 ${dStr}）` : (diffDays === 0 ? `今日到期（${dStr}）` : `${diffDays} 天后到期（${dStr}）`)
      });
    }
  }

  return alerts.filter(a => {
    if (cfg.dismissedIds && cfg.dismissedIds[a.id]) return false;
    const snz = cfg.snoozedUntil && cfg.snoozedUntil[a.id];
    if (snz && snz > todayStr) return false;
    return true;
  });
}

function buildEmailHtml(alerts, todayStr, appUrl) {
  const rows = alerts.length > 0
    ? alerts.map(a => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;">
            <span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;background:${a.level === '高优' ? '#fee2e2;color:#b91c1c' : '#fef3c7;color:#92400e'};margin-right:6px;">${a.level}</span>
            <strong>${a.icon} ${escHtml(a.title)}</strong>
            <div style="color:#64748b;font-size:12px;margin-top:3px;">${escHtml(a.detail)}</div>
          </td>
        </tr>`).join('')
    : `<tr><td style="padding:18px;text-align:center;color:#047857;font-size:13px;">✅ 今日暂无待处理异常提醒，所有在途包裹与代购账目状态良好！</td></tr>`;

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:620px;margin:0 auto;background:#f8fafc;padding:20px;">
    <div style="background:linear-gradient(135deg,#022c22,#065f46);color:#ffffff;padding:18px 20px;border-radius:12px 12px 0 0;">
      <div style="font-size:16px;font-weight:800;">🔔 纽澳跨境采购每日提醒播报</div>
      <div style="font-size:12px;color:#a7f3d0;margin-top:4px;">奥克兰日期：${todayStr} · 共检出 ${alerts.length} 项待办提醒</div>
    </div>
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:12px 16px 20px;">
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <div style="margin-top:18px;text-align:center;">
        <a href="${escHtml(appUrl)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;">打开纽澳跨境采购管家处理 ➔</a>
      </div>
      <div style="margin-top:16px;font-size:11px;color:#94a3b8;text-align:center;">本邮件由 Cloudflare Pages (/api/remind) + Resend 自动发送；如需延后或调整阈值，请在网页右上角「🔔 提醒」中设置并保存同步。</div>
    </div>
  </div>`;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const forceSend = url.searchParams.get('force') === '1';

  const kv = getKvBinding(env);
  if (!kv) {
    return Response.json({ ok: false, error: '未检测到 KV 绑定（请确认 Pages 已绑定 NZ_TRACKER_KV）' }, { status: 500 });
  }

  const toEmail = env.ALERT_EMAIL || env.NOTIFY_TO_EMAIL;
  if (!env.RESEND_API_KEY || !toEmail) {
    return Response.json({ ok: false, error: '请在 Pages 环境变量中配置 RESEND_API_KEY 与 ALERT_EMAIL' }, { status: 500 });
  }

  const raw = await kv.get('nz_tracker_latest_v7');
  if (!raw) {
    return Response.json({ ok: false, error: 'KV 中暂无 nz_tracker_latest_v7 数据，请先在网页端点击一次云端推送' }, { status: 404 });
  }

  const data = JSON.parse(raw);
  const todayStr = getNzTodayStr();
  const alerts = collectAlerts(data, todayStr);

  if (alerts.length === 0 && !forceSend) {
    return Response.json({ ok: true, skipped: true, reason: '今日无待办提醒，已静默跳过发信', todayStr });
  }

  const fromEmail = env.FROM_EMAIL || env.NOTIFY_FROM_EMAIL || 'onboarding@resend.dev';
  const appUrl = env.APP_URL || url.origin;
  const subject = alerts.length > 0
    ? `🔔 [纽澳采购提醒 ${todayStr}] 有 ${alerts.length} 项待处理（${alerts[0].title.slice(0, 24)}...）`
    : `✅ [纽澳采购测试 ${todayStr}] 邮件提醒通道运行正常`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject,
      html: buildEmailHtml(alerts, todayStr, appUrl)
    })
  });

  const resJson = await res.json().catch(() => ({}));
  return Response.json({ ok: res.ok, status: res.status, alertCount: alerts.length, resend: resJson }, { status: res.ok ? 200 : 500 });
}