// Supabase Edge Function: send-push
// Triggered by a Database Webhook on INSERT into bbw_requests.
// Loops every stored push subscription and sends a Web Push.
//
// Deploy:
//   supabase functions deploy send-push --no-verify-jwt
// Secrets required (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=xxx VAPID_PRIVATE_KEY=yyy VAPID_SUBJECT=mailto:maintenance@brunswickbierworks.com
//   supabase secrets set SB_URL=https://YOURPROJECT.supabase.co SB_SERVICE_ROLE=your-service-role-key

import webpush from "https://esm.sh/web-push@3.6.7";

const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:maintenance@brunswickbierworks.com";
const SB_URL        = Deno.env.get("SB_URL")!;
const SB_SERVICE    = Deno.env.get("SB_SERVICE_ROLE")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

Deno.serve(async (req) => {
  try {
    const payload = await req.json().catch(() => ({}));
    // Database Webhook sends { type, table, record, ... }
    const rec = payload.record || payload.new || payload || {};
    const asset = rec.asset_name || rec.department || "New request";
    const who   = rec.reporter || "Someone";

    const notif = JSON.stringify({
      title: "BBW Maintenance — New Request",
      body:  asset + "\nFrom: " + who,
      url:   "./?tab=requests",
      tag:   "bbw-req-" + (rec.id || Date.now()),
      requireInteraction: false,
    });

    // Fetch all subscriptions via service role
    const subsRes = await fetch(SB_URL + "/rest/v1/bbw_push_subs?select=endpoint,p256dh,auth", {
      headers: {
        "apikey": SB_SERVICE,
        "Authorization": "Bearer " + SB_SERVICE,
      },
    });
    const subs = await subsRes.json();

    let sent = 0, dead: string[] = [];
    await Promise.all((subs || []).map(async (s: any) => {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(sub, notif);
        sent++;
      } catch (err: any) {
        // 404/410 = subscription expired; mark for cleanup
        if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(s.endpoint);
      }
    }));

    // Clean up dead subscriptions
    if (dead.length) {
      await Promise.all(dead.map((ep) =>
        fetch(SB_URL + "/rest/v1/bbw_push_subs?endpoint=eq." + encodeURIComponent(ep), {
          method: "DELETE",
          headers: { "apikey": SB_SERVICE, "Authorization": "Bearer " + SB_SERVICE },
        })
      ));
    }

    return new Response(JSON.stringify({ sent, cleaned: dead.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
