import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { error } = await supabase.from('wallets').select('id').limit(1);

  return Response.json({ ok: !error, error: error?.message ?? null, at: new Date().toISOString() });
}
