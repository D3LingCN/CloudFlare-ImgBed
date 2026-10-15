// Fixed local vector artwork: no R2, network fetch, or image generation.
const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180" viewBox="0 0 480 180"><rect width="480" height="180" rx="16" fill="#f3f5f8"/><path d="M220 45h40v30h-40zM225 70l9-10 7 7 6-5 8 8" fill="none" stroke="#8290a4" stroke-width="3"/><text x="240" y="108" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#334155">图片服务暂时休息</text><text x="240" y="140" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#64748b">MESSAGE</text></svg>`;
const cache = new Map();
export function servicePlaceholder(request, env = {}) {
    // Only publish an operator-confirmed time; quota reset alone cannot restore storage.
    const configured = env.IMGBED_RESTORE_AT;
    const timestamp = typeof configured === 'string' ? Date.parse(configured) : NaN;
    const date = Number.isFinite(timestamp) && timestamp > Date.now()
        ? new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(timestamp) : null;
    const message = date ? `预计 ${date} 恢复，请稍后再来` : '服务维护中，请稍后再试';
    if (!cache.has(message)) {
        cache.clear();
        cache.set(message, artwork.replace('MESSAGE', message));
    }
    // 200 lets <img> render; no-store prevents the placeholder surviving recovery.
    return new Response(request.method === 'HEAD' ? null : cache.get(message), {
        status:200, headers:{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store',
            'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"},
    });
}
