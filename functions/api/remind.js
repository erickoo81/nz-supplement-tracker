/**
 * Cloudflare Pages Function: functions/api/remind.js
 * 直接放进你现有的 GitHub 仓库 nz-supplement-tracker 的 functions/api/ 目录下即可！
 * 无需新建 Worker，直接复用现有 Pages 项目绑定的 NZ_TRACKER_KV。
 *
 * 支持【邮件 (Resend) + 微信 (PushPlus)】双通道同时推送 + 🛂 海关防撞车预警（7天同收件人≥2单）！
 *
 * 在 Cloudflare Pages (nz-supplement-tracker -> Settings -> Environment variables) 配置以下变量：
 *   1. RESEND_API_KEY  : Resend 密钥 (re_xxxx)
 *   2. ALERT_EMAIL     : 接收提醒的邮箱（未绑域名时填注册 Resend 的邮箱，多个可用逗号分隔）
 *   3. PUSHPLUS_TOKEN  : PushPlus 微信推送 Token（在 pushplus.plus 微信扫码免费获取，填入即开启微信推送）
 *   （可选）FROM_NAME  : 邮件发件人显示名称，不填默认 "纽澳跨境采购管家"
 *   （可选）FROM_EMAIL : 发件人邮箱，不填默认 "onboarding@resend.dev"
 *   （可选）APP_URL    : 你的网站地址，不填自动使用当前访问域名
 *
 * 定时触发：在 cron-job.org 保持每日任务，时区选 Pacific/Auckland（如每天 09:00 或 10:00），
 *   URL 填：https://nz-supplement-tracker.pages.dev/api/remind
 * 手动测试双通道：浏览器直接访问 https://nz-supplement-tracker.pages.dev/api/remind?force=1
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
  if (parcels.length === 0) return o.deliveredDate ? 'DELIVERED' : 'PENDING';
  const deliv = parcels.filter(p => p && String(p.deliveredDate || '').trim()).length;
  if (deliv === parcels.length) return 'DELIVERED';
  return deliv > 0 ? 'PARTIAL' : 'IN_TRANSIT';
}

function isFriendDaigou(o) {
  const rec = String(o.recipient || '').trim();
  return Boolean(rec && rec !== 'HOME' && rec !== '自用' && rec !== '家里');
}

function collectAlerts(data, todayStr) {
  const cfg = Object.assign(
    {
      transitOverdueDays: 14,
      urgentOverdueDays: 21,
      missingTrackDays: 3,
      expiryWarnDays: 60,
      customsWindowDays: 7,
      enableLogistics: true,
      enableCustoms: true,
      enableDaigou: true,
      enableExpiry: true,
      snoozedUntil: {},
      dismissedIds: {},
      customReminders: []
    },
    data.reminderConfig || {}
  );
  const todayMs = new Date(todayStr + 'T00:00:00Z').getTime();
  const dayMs = 86400000;
  const alerts = [];

  const orders = (Array.isArray(data.orders) ? data.orders : []).filter(o => o && !o.cancelled);
  const rec7dMap = {};

  // 1. 物流缺运单 / 在途超时 / 拆单掉队 + 海关防撞车统计
  for (const o of orders) {
    const st = getOrderStatus(o);
    const isSelf = o.recipient === '自用' || o.merchant === 'CW';
    if (isSelf || st === 'DELIVERED') continue;

    const ordMs = o.orderDate ? new Date(o.orderDate + 'T00:00:00Z').getTime() : NaN;
    const daysSince = isNaN(ordMs) ? 0 : Math.floor((todayMs - ordMs) / dayMs);
    const parcels = Array.isArray(o.parcels) ? o.parcels : [];
    const hasMissingTrack = parcels.length === 0 || parcels.some(p => !String(p.trackingNo || '').trim());

    // 1B. 海关防撞车统计（同收件人近 7 天内寄回国在途）
    const winDays = Number(cfg.customsWindowDays) > 0 ? Number(cfg.customsWindowDays) : 7;
    if (cfg.enableCustoms !== false && !isNaN(ordMs) && daysSince >= 0 && daysSince <= winDays && o.recipient) {
      if (!rec7dMap[o.recipient]) rec7dMap[o.recipient] = [];
      rec7dMap[o.recipient].push(o);
    }

    if (cfg.enableLogistics !== false) {
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
        const urgentDays = Number(cfg.urgentOverdueDays) > 0 ? Number(cfg.urgentOverdueDays) : cfg.transitOverdueDays + 7;
        alerts.push({
          id: `rem_overdue_${o.id}`,
          level: daysSince >= urgentDays ? '高优' : '关注',
          icon: daysSince >= urgentDays ? '🚨' : '🚚',
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
  }

  // 1B. 输出海关防撞车预警（7天同收件人 ≥ 2 单）
  if (cfg.enableCustoms !== false) {
    const winDays = Number(cfg.customsWindowDays) > 0 ? Number(cfg.customsWindowDays) : 7;
    for (const [rec, list] of Object.entries(rec7dMap)) {
      if (list.length >= 2) {
        alerts.push({
          id: `rem_customs_${rec}_${todayStr.slice(0, 7)}`,
          level: '高优',
          icon: '🛂',
          title: `海关防撞车预警：「${rec}」近 ${winDays} 天已有 ${list.length} 单寄回国在途`,
          detail: `涉及订单：${list.map(x => `${x.orderDate || ''} ${x.merchant || ''}`).join('、')}。建议下一单错开发货或更换备用收件人，避免海关同批查验/补税。`
        });
      }
    }
  }

  // 2. 2026+ 朋友代购待结算
  if (cfg.enableDaigou !== false) {
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
  }

  // 3. 保质期临期提醒
  if (cfg.enableExpiry !== false) {
    const expMap = data.productExpiryDates || {};
    for (const [prod, expDate] of Object.entries(expMap)) {
      if (!expDate) continue;
      const daysLeft = Math.floor((new Date(expDate + 'T00:00:00Z').getTime() - todayMs) / dayMs);
      if (!isNaN(daysLeft) && daysLeft <= cfg.expiryWarnDays) {
        alerts.push({
          id: `rem_exp_${prod}_${expDate}`,
          level: daysLeft <= 14 ? '高优' : '关注',
          icon: '💊',
          title: daysLeft < 0 ? `已过期 ${Math.abs(daysLeft)} 天：${prod}` : `保质期临期（剩 ${daysLeft} 天）：${prod}`,
          detail: `登记效期至 ${expDate}`
        });
      }
    }
  }

  // 4. 自定义备忘（已逾期 / 今日到期 / 未来 3 天内到期）
  for (const cr of (cfg.customReminders || [])) {
    if (!cr || cr.done) continue;
    const dStr = cr.dueDate || todayStr;
    const diffDays = Math.floor((new Date(dStr + 'T00:00:00Z').getTime() - todayMs) / dayMs);
    if (!isNaN(diffDays) && diffDays <= 3) {
      alerts.push({
        id: cr.id,
        level: diffDays <= 0 ? '高优' : '关注',
        icon: '📌',
        title: cr.title,
        detail: diffDays < 0 ? `已逾期 ${Math.abs(diffDays)} 天（计划日 ${dStr}）` : (diffDays === 0 ? `今日到期（${dStr}）` : `${diffDays} 天后到期（${dStr}）`)
      });
    }
  }

  const active = alerts.filter(a => {
    if (cfg.dismissedIds && cfg.dismissedIds[a.id]) return false;
    const snz = cfg.snoozedUntil && cfg.snoozedUntil[a.id];
    if (snz && snz > todayStr) return false;
    return true;
  });

  // 高优置顶
  active.sort((a, b) => (a.level === '高优' ? 0 : 1) - (b.level === '高优' ? 0 : 1));
  return { cfg, alerts: active };
}

function buildMessageHtml(alerts, todayStr, appUrl) {
  const rows = alerts.length > 0
    ? alerts.map(a => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;">
            <span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;background:${a.level === '高优' ? '#fee2e2;color:#b91c1c' : '#fef3c7;color:#92400e'};margin-right:6px;">${a.level}</span>
            <strong>${a.icon} ${escHtml(a.title)}</strong>
            <div style="color:#64748b;font-size:12px;margin-top:3px;">${escHtml(a.detail)}</div>
          </td>
        </tr>`).join('')
    : `<tr><td style="padding:18px;text-align:center;color:#047857;font-size:13px;">✅ 今日暂无待处理异常提醒，所有在途包裹、海关防撞车与代购账目状态良好！</td></tr>`;

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:620px;margin:0 auto;background:#f8fafc;padding:16px;">
    <div style="background:linear-gradient(135deg,#022c22,#065f46);color:#ffffff;padding:16px 18px;border-radius:12px 12px 0 0;">
      <div style="font-size:16px;font-weight:800;">🔔 纽澳跨境采购每日提醒播报</div>
      <div style="font-size:12px;color:#a7f3d0;margin-top:4px;">奥克兰日期：${todayStr} · 共检出 ${alerts.length} 项待办提醒</div>
    </div>
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:12px 14px 18px;">
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <div style="margin-top:16px;text-align:center;">
        <a href="${escHtml(appUrl)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;">打开纽澳跨境采购管家处理 ➔</a>
      </div>
      <div style="margin-top:14px;font-size:11px;color:#94a3b8;text-align:center;">本提醒由 Cloudflare Pages (/api/remind) 通过 邮件 + 微信(PushPlus) 双通道自动发送</div>
    </div>
  </div>`;
}

async function sendResendEmail(env, toRaw, subject, htmlBody) {
  const recipients = String(toRaw || '').split(/[,;，；\s]+/).map(s => s.trim()).filter(Boolean);
  if (!env.RESEND_API_KEY || recipients.length === 0) {
    return { configured: false, ok: false, skipped: true, reason: '未配置 RESEND_API_KEY 或 ALERT_EMAIL' };
  }
  const rawFrom = String(env.FROM_EMAIL || env.NOTIFY_FROM_EMAIL || 'onboarding@resend.dev').trim();
  const fromName = String(env.FROM_NAME || '纽澳跨境采购管家').trim();
  const fromEmail = rawFrom.includes('<') ? rawFrom : `${fromName} <${rawFrom}>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipients,
        subject,
        html: htmlBody
      })
    });
    const resJson = await res.json().catch(() => ({}));
    return { configured: true, ok: res.ok, status: res.status, from: fromEmail, data: resJson };
  } catch (err) {
    return { configured: true, ok: false, error: String(err) };
  }
}

async function sendPushPlusWeChat(token, title, htmlBody) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    return { configured: false, ok: false, skipped: true, reason: '未配置 PUSHPLUS_TOKEN' };
  }
  try {
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: cleanToken,
        title,
        content: htmlBody,
        template: 'html'
      })
    });
    const resJson = await res.json().catch(() => ({}));
    const ok = res.ok && Number(resJson.code) === 200;
    return { configured: true, ok, status: res.status, data: resJson };
  } catch (err) {
    return { configured: true, ok: false, error: String(err) };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const forceSend = url.searchParams.get('force') === '1';

  const kv = getKvBinding(env);
  if (!kv) {
    return Response.json({ ok: false, error: '未检测到 KV 绑定（请确认 Pages 已绑定 NZ_TRACKER_KV）' }, { status: 500 });
  }

  const raw = await kv.get('nz_tracker_latest_v7');
  if (!raw) {
    return Response.json({ ok: false, error: 'KV 中暂无 nz_tracker_latest_v7 数据，请先在网页端点击一次云端推送' }, { status: 404 });
  }

  const parsed = JSON.parse(raw);
  const data = parsed && parsed.state ? parsed.state : parsed;
  const todayStr = getNzTodayStr();
  const { cfg, alerts } = collectAlerts(data, todayStr);

  if (!forceSend && cfg.emailPushEnabled === false) {
    return Response.json({ ok: true, skipped: true, reason: '网页端已关闭每日定时推送开关', todayStr });
  }

  if (alerts.length === 0 && !forceSend) {
    return Response.json({ ok: true, skipped: true, reason: '今日无待办提醒，已静默跳过双通道推送', todayStr, alertCount: 0 });
  }

  const toEmail = env.ALERT_EMAIL || env.NOTIFY_TO_EMAIL || cfg.emailTo || '';
  const pushplusToken = env.PUSHPLUS_TOKEN || cfg.pushplusToken || '';
  if ((!env.RESEND_API_KEY || !toEmail) && !pushplusToken) {
    return Response.json({ ok: false, error: '请至少配置 Resend (RESEND_API_KEY + ALERT_EMAIL) 或 PushPlus (PUSHPLUS_TOKEN)' }, { status: 500 });
  }

  const appUrl = env.APP_URL || url.origin;
  const subject = alerts.length > 0
    ? `🔔 [纽澳采购提醒 ${todayStr}] 有 ${alerts.length} 项待处理（${alerts[0].title.slice(0, 22)}）`
    : `✅ [纽澳采购测试 ${todayStr}] 微信+邮件双通道运行正常`;
  const htmlBody = buildMessageHtml(alerts, todayStr, appUrl);

  const [resendResult, pushplusResult] = await Promise.all([
    sendResendEmail(env, toEmail, subject, htmlBody),
    sendPushPlusWeChat(pushplusToken, subject, htmlBody)
  ]);

  const anySuccess = Boolean(
    (resendResult.configured && resendResult.ok) ||
    (pushplusResult.configured && pushplusResult.ok)
  );

  return Response.json(
    {
      ok: anySuccess,
      todayStr,
      alertCount: alerts.length,
      channels: {
        resend: resendResult,
        pushplus: pushplusResult
      }
    },
    { status: anySuccess ? 200 : 500 }
  );
}