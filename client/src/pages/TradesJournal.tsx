import { useEffect, useState } from "react";
import { useTrades } from "@/hooks/use-trades";
import { useJournals, useCreateJournal, getSignedUrl } from "@/hooks/use-journals";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

export default function TradesJournal() {
  const { toast } = useToast();
  const { data: trades } = useTrades();
  const { data: journals } = useJournals();
  const create = useCreateJournal();

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewMap, setPreviewMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const j of journals ?? []) {
        if (j.screenshot_path) {
          try {
            next[j.id] = await getSignedUrl(j.screenshot_path);
          } catch {
            // ignore
          }
        }
      }
      if (!cancelled) setPreviewMap(next);
    })();
    return () => { cancelled = true; };
  }, [journals]);

  const upload = async () => {
    const sess = (await supabase.auth.getSession()).data.session;
    const userId = sess?.user.id;
    if (!userId) throw new Error("Not logged in");
    if (!file) throw new Error("Pick a screenshot");

    const path = `${userId}/${crypto.randomUUID()}-${file.name}`;
    const { error } = await supabase.storage.from("journal-screenshots").upload(path, file, { upsert: false });
    if (error) throw error;
    return path;
  };

  const createJournal = async () => {
    try {
      const screenshot_path = file ? await upload() : null;
      await create.mutateAsync({ title, note, tags: [], screenshot_path });
      toast({ title: "Journal saved" });
      setTitle("");
      setNote("");
      setFile(null);
    } catch (e: any) {
      toast({ title: "Save failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Trades & Journal</div>
        <div className="text-sm text-muted-foreground">Trades saved in Supabase, journal supports screenshot uploads.</div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold mb-3">Recent Trades</div>
          <div className="space-y-2">
            {(trades ?? []).slice(0, 30).map((t) => (
              <div key={t.id} className="rounded-lg border border-border bg-background px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{t.symbol} • {t.side.toUpperCase()}</div>
                  <div className="text-xs text-muted-foreground">{t.mode}</div>
                </div>
                <div className="text-xs text-muted-foreground">{t.strategy_id} • {t.timeframe}</div>
                <div className="text-xs text-muted-foreground">PnL: {t.profit ?? 0}</div>
              </div>
            ))}
            {(trades ?? []).length === 0 ? <div className="text-sm text-muted-foreground">No trades yet.</div> : null}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="font-semibold">New Journal Entry</div>
          <label className="block text-sm">Title</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="block text-sm">Note</label>
          <textarea className="w-full h-28 rounded-lg border border-border bg-background px-3 py-2" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="block text-sm">Screenshot (optional)</label>
          <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button onClick={createJournal} className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90">
            Save Journal
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="font-semibold mb-3">Journal</div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(journals ?? []).map((j) => (
            <div key={j.id} className="rounded-xl border border-border bg-background p-3">
              <div className="font-medium">{j.title}</div>
              <div className="text-xs text-muted-foreground">{new Date(j.created_at).toLocaleString()}</div>
              <div className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">{j.note}</div>
              {previewMap[j.id] ? (
                <img src={previewMap[j.id]} className="mt-3 w-full rounded-lg border border-border" alt="journal screenshot" />
              ) : null}
            </div>
          ))}
          {(journals ?? []).length === 0 ? <div className="text-sm text-muted-foreground">No journal entries yet.</div> : null}
        </div>
      </div>
    </div>
  );
}
