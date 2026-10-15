// Cloudflare deployment is retired during the server migration.
// The server deployment must explicitly set IMGBED_HOSTING_MODE=server.
// Reject before auth, databases, usage analytics, or object storage are touched.
export async function onRequest(context) {
    if (context.env.IMGBED_HOSTING_MODE === 'server') return context.next();
    return new Response(context.request.method === 'HEAD' ? null :
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>服务暂时维护</title><body style="font:16px/1.8 sans-serif;text-align:center;padding:15vh 20px"><h2>图床正在迁移</h2><p>服务暂时维护，请稍后再来。</p></body></html>', {
        status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},
    });
}
