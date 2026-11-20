// ИИ в панели «Выручка фич» (решения PO 18.11.2026): кнопки «Оценить новые», «Переоценить все», «Ревью»
// и режим ревью на всю панель — одна фича за раз, правки входов и комментарий уходят ИИ (server: ai.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Data = any;
type Fx = any;
type Inputs = Record<string, Record<string, number>>;
type Edit = { id: string; name: string; unit: string; from: number; to: number };
type St = "none" | "accepted" | "sent" | "done" | "question";
type RvItem = { status: Exclude<St, "none">; at: string; round: number; comment?: string; edits?: Edit[]; before?: number | null; after?: number | null; ai_note?: string; ai_at?: string };
type Rv = { release: string; threadId: string | null; items: Record<string, RvItem> } | null;
type Run = { threadId: string; mode: "new" | "all"; startedAt: string; keys: string[] } | null;
export type AiState = { run: Run; runStatus: string | null; review: Rv; reviewStatus: string | null; cfgMtime: number };
type Rpc = { call: (name: any, input: any) => Promise<any> };

const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 1.5px, transparent 1.5px 4.5px)" };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* нет доступа */ } },
};
const ddmm = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : iso === "all" ? "все фичи" : iso === "none" ? "без релиза" : "—");
const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const t = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${t}`;
};
const thv = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v / 1000).toLocaleString("ru-RU").replace("-", "−")}`);
const fmtV = (v: number, unit: string) => (unit === "доля" ? `${+(v * 100).toFixed(2)}%` : `${+v.toFixed(4)}${unit && unit !== "доля" ? " " + unit : ""}`);
const monthExp = (fx: Fx | undefined): number | null => fx?.vals?.month?.exp ?? null;
const nonzero = (fx: Fx) => fx.has && (["neg", "exp", "pos"] as const).some((s) => Math.abs(fx.vals?.month?.[s] ?? 0) > 0.5 || Math.abs(fx.vals?.ny?.[s] ?? 0) > 0.5);
/** тред ИИ ещё работает: всё, кроме «свободен», «ошибка», «удалён» */
export const aiBusy = (s: string | null | undefined) => !!s && !["idle", "error", "gone", "failed", "stopped", "completed"].includes(s);
const threadWord = (s: string | null | undefined) => (!s ? "" : s === "idle" ? "готово" : s === "error" || s === "failed" ? "ошибка" : s === "gone" ? "тред удалён" : s === "pending" ? "ждёт ответа в треде" : "идёт");

const AI_C = "var(--pr-merged)";
const mixC = (c: string, p: number) => `color-mix(in oklab, ${c} ${p}%, transparent)`;
const ST: Record<St, { label: string; short: string; c: string; hatch?: boolean }> = {
  none: { label: "Не смотрели", short: "не смотрели", c: "var(--border)" },
  accepted: { label: "Принято", short: "принято", c: "var(--success)" },
  sent: { label: "ИИ в работе", short: "у ИИ", c: AI_C, hatch: true },
  done: { label: "ИИ доработал — посмотрите снова", short: "ИИ доработал", c: "var(--fr-info, var(--timeline-accent))" },
  question: { label: "ИИ спрашивает", short: "вопрос ИИ", c: "var(--fr-att, var(--attention))" },
};
const stOf = (rv: Rv, key: string): St => rv?.items?.[key]?.status ?? "none";

function Swatch({ st, className }: { st: St; className?: string }) {
  const s = ST[st];
  return <span className={cn("inline-block rounded-sm", className)} style={s.hatch ? { backgroundImage: `repeating-linear-gradient(45deg, ${s.c} 0 1.5px, transparent 1.5px 4.5px)` } : { background: s.c }} />;
}
function MenuItem({ icon, title, note, disabled, onClick }: { icon: string; title: ReactNode; note: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left enabled:hover:bg-state-hover disabled:opacity-45">
      <span className="mt-0.5 shrink-0" style={{ color: AI_C }}><Icon name={icon} fallback="Zap" className="size-4" /></span>
      <span className="min-w-0"><span className="block font-medium">{title}</span><span className="block text-[11.5px] leading-snug text-muted-foreground">{note}</span></span>
    </button>
  );
}

// ---------- состояние ИИ релиза: опрос сервера ----------
export function useAi(rpc: Rpc, file: string | null, release: string | null, fast: boolean, onCfgChange: () => void) {
  const [st, setSt] = useState<AiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mt = useRef<{ key: string; v: number } | null>(null);
  const cb = useRef(onCfgChange);
  cb.current = onCfgChange;
  const key = file && release ? `${file}|${release}` : null;
  const refresh = useCallback(() => {
    if (!file || !release) return Promise.resolve();
    return rpc.call("ai_state", { file, release }).then((s: AiState) => {
      if (!s || typeof s !== "object" || !("cfgMtime" in s)) return;
      setSt(s); setError(null);
      // ИИ записал features.json — перечитать релиз (первое значение — точка отсчёта)
      const k = `${file}|${release}`;
      if (mt.current?.key === k && mt.current.v !== s.cfgMtime) cb.current();
      mt.current = { key: k, v: s.cfgMtime };
    }, (e: unknown) => setError(errText(e)));
  }, [rpc, file, release]);
  useEffect(() => { setSt(null); void refresh(); }, [key, refresh]);
  const working = aiBusy(st?.runStatus) || Object.values(st?.review?.items ?? {}).some((x) => x.status === "sent");
  useEffect(() => {
    if (!key) return;
    const t = setInterval(() => void refresh(), fast ? 5_000 : working ? 10_000 : 30_000);
    return () => clearInterval(t);
  }, [key, fast, working, refresh]);
  return { st, error, refresh };
}

// ---------- кнопки в шапке ----------
export function AiActions({ rpc, file, release, ai, unest, estimated, onReview, onOpenThread }: {
  rpc: Rpc; file: string; release: string; ai: ReturnType<typeof useAi>; unest: number; estimated: number;
  onReview: () => void; onOpenThread: (id: string) => void;
}) {
  const [ask, setAsk] = useState<"new" | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(release);
  const run = ai.st?.run ?? null;
  const runBusy = aiBusy(ai.st?.runStatus);
  const recent = run && Date.now() - +new Date(run.startedAt) < 3 * 864e5;
  const rv = ai.st?.review ?? null;
  const done = rv ? Object.values(rv.items).filter((x) => x.status === "accepted").length : 0;
  useEffect(() => { setAsk(null); setMsg(null); }, [file, release]);
  const start = (mode: "new" | "all") => {
    setBusy(true); setMsg(null);
    rpc.call("ai_estimate", { file, release, mode }).then(
      (r: { threadId: string; reused: boolean; count: number }) => {
        setBusy(false); setAsk(null); setOpen(false);
        setMsg(r.reused ? "Оценка по этому релизу уже идёт" : `ИИ начал: ${r.count} ${r.count === 1 ? "эпик" : r.count < 5 ? "эпика" : "эпиков"}`);
        void ai.refresh();
      },
      (e: unknown) => { setBusy(false); setMsg(errText(e)); },
    );
  };
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const questions = rv ? Object.values(rv.items).filter((x) => x.status === "question").length : 0;
  useEffect(() => { setOpen(false); }, [file, release]);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setAsk(null); } };
    document.addEventListener("mousedown", f);
    return () => document.removeEventListener("mousedown", f);
  }, [open]);
  return (
    <div ref={box} className="relative flex flex-wrap items-center justify-end gap-2 pb-1.5">
      {msg && !ask && !open && <span className="text-[12px] text-muted-foreground">{msg}</span>}
      <button type="button" onClick={() => { setOpen(!open); setAsk(null); }} aria-expanded={open} title="Оценка ИИ и ревью релиза"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors"
        style={{ color: AI_C, borderColor: mixC(AI_C, 45), background: mixC(AI_C, open ? 22 : 12), boxShadow: runBusy ? `0 0 12px ${mixC(AI_C, 45)}` : undefined }}>
        {runBusy ? <span className="inline-block size-1.5 animate-pulse rounded-full" style={{ background: AI_C }} /> : <Icon name="Sparkles" fallback="Zap" className="size-3.5" />}
        ИИ
        {rv && estimated ? <span className="font-normal opacity-80">· ревью {Math.min(done, estimated)}/{estimated}</span> : null}
        {questions ? <span className="rounded-full px-1.5 text-[10.5px] font-semibold" style={{ background: "var(--fr-att, var(--attention))", color: "var(--background)" }}>{questions}</span> : null}
        <Icon name="ChevronDown" className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[400px] rounded-lg border bg-background p-1.5 text-[12.5px] shadow-lg" style={{ borderColor: mixC(AI_C, 35) }}>
          {recent && run && (
            <button type="button" onClick={() => onOpenThread(run.threadId)} title="Открыть тред ИИ"
              className="mb-1 flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-state-hover hover:text-foreground">
              {runBusy && <span className="inline-block size-1.5 animate-pulse rounded-full" style={{ background: AI_C }} />}
              ИИ: {run.mode === "new" ? "оценка" : "переоценка"} {runBusy ? "идёт" : `${threadWord(ai.st?.runStatus)} · ${when(run.startedAt)}`}
              <Icon name="ExternalLink" fallback="ChevronRight" className="ml-auto size-3.5" />
            </button>
          )}
          {!ask && (
            <>
              <MenuItem icon="Sparkles" title={<>Оценить новые{unest ? ` · ${unest}` : ""}</>} disabled={!dated || !unest || runBusy} onClick={() => setAsk("new")}
                note={!dated ? "Выберите конкретный релиз" : !unest ? "Все эпики релиза уже оценены" : runBusy ? "ИИ уже оценивает этот релиз" : "ИИ оценит эпики релиза без оценки и запишет в features.json"} />
              <MenuItem icon="RefreshCw" title="Переоценить все" disabled={!dated || (!unest && !estimated) || runBusy} onClick={() => setAsk("all")}
                note={!dated ? "Выберите конкретный релиз" : runBusy ? "ИИ уже оценивает этот релиз" : "ИИ сверит все фичи релиза с PRD, Jira и данными"} />
              <MenuItem icon="ListChecks" title={<>Ревью{rv && estimated ? ` · ${Math.min(done, estimated)}/${estimated}` : ""}{questions ? ` · вопросов ${questions}` : ""}</>} disabled={!estimated}
                onClick={() => { setOpen(false); onReview(); }} note={estimated ? "Фича за фичей: «Далее» без правок — принято, правки и комментарий уходят ИИ" : "В релизе нет оценённых фич"} />
              {msg && <p className="px-2.5 pb-1 text-[11.5px] text-muted-foreground">{msg}</p>}
            </>
          )}
          {ask && (
            <div className="p-2">
              <p className="leading-snug">
                {ask === "new"
                  ? <>ИИ оценит <b>{unest} {unest === 1 ? "эпик" : unest < 5 ? "эпика" : "эпиков"}</b> релиза {ddmm(release)} без оценки и запишет их в features.json.</>
                  : <>ИИ переоценит <b>{estimated} {estimated === 1 ? "фичу" : estimated < 5 ? "фичи" : "фич"}</b> релиза {ddmm(release)}{unest ? <> и оценит {unest} новых</> : null}: сверит входы с PRD, Jira и данными. Без новых данных фичу не меняет.</>}
              </p>
              <p className="mt-1.5 text-[11.5px] text-subtle-foreground">Работает в отдельном треде. Панель обновится сама, когда ИИ запишет файл. В Jira ИИ не пишет.</p>
              {msg && <p className="mt-1.5 text-[12px] text-destructive-text">{msg}</p>}
              <div className="mt-2.5 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setAsk(null)}>Назад</Button>
                <Button size="sm" disabled={busy} onClick={() => start(ask)}>{busy ? "Запускаю…" : "Запустить ИИ"}</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- режим ревью ----------
export function ReviewMode({ rpc, file, release, base, now, ov, clearOv, ai, renderFeature, onExit, onOpenThread, fetching }: {
  rpc: Rpc; file: string; release: string; base: Data; now: Data; ov: Inputs; clearOv: (key: string) => void;
  ai: ReturnType<typeof useAi>; renderFeature: (key: string) => ReactNode; onExit: () => void; onOpenThread: (id: string) => void; fetching: boolean;
}) {
  const rv: Rv = ai.st?.review ?? null;
  // порядок как в «Путь числа»: фичи с числом от большего к меньшему, потом фичи с нулём
  const order: Fx[] = useMemo(() => {
    const all: Fx[] = base?._explain ?? [];
    const nz = all.filter(nonzero).sort((a, b) => (monthExp(b) ?? 0) - (monthExp(a) ?? 0));
    return [...nz, ...all.filter((f) => !nonzero(f))];
  }, [base]);
  const curKey = `fr.rv.cur.${file}.${release}`;
  const draftKey = `fr.rv.c.${file}.${release}`;
  const [cur, setCurState] = useState<string | null>(() => ls.get(curKey));
  const [drafts, setDrafts] = useState<Record<string, string>>(() => { try { return JSON.parse(ls.get(draftKey) ?? "{}") ?? {}; } catch { return {}; } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [askReset, setAskReset] = useState(false);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const setCur = (k: string) => { setCurState(k); ls.set(curKey, k); setErr(null); mainRef.current?.scrollTo({ top: 0 }); };
  useEffect(() => ls.set(draftKey, JSON.stringify(drafts)), [drafts, draftKey]);
  // старт: сохранённая фича или первая, по которой нужно действие PO
  useEffect(() => {
    if (!order.length) return;
    if (cur === "__end" || (cur && order.some((f) => f.key === cur))) return;
    const first = order.find((f) => ["none", "done", "question"].includes(stOf(rv, f.key))) ?? order[0];
    setCurState(first.key);
  }, [order, rv]); // eslint-disable-line react-hooks/exhaustive-deps
  // ИИ отметил фичу: конфиг уже с правками — убрать те же правки из панели, чтобы не задвоить
  useEffect(() => {
    for (const [k, it] of Object.entries(rv?.items ?? {})) {
      if ((it.status !== "done" && it.status !== "question") || !it.edits?.length || !ov[k]) continue;
      const o = ov[k];
      const same = Object.keys(o).length === it.edits.length && it.edits.every((e) => o[e.id] != null && Math.abs(o[e.id] - e.to) < 1e-12);
      if (same) clearOv(k);
    }
  }, [rv, ov, clearOv]);

  const idx = order.findIndex((f) => f.key === cur);
  const fx: Fx | undefined = order[idx];
  const nowFx: Fx | undefined = (now?._explain ?? []).find((f: Fx) => f.key === fx?.key);
  const st: St = fx ? stOf(rv, fx.key) : "none";
  const item = fx ? rv?.items?.[fx.key] : undefined;
  const edits: Edit[] = fx ? Object.entries(ov[fx.key] ?? {}).map(([id, to]) => {
    const inp = (fx.inputs ?? []).find((x: any) => x.id === id);
    const from = inp?.values?.exp ?? inp?.value ?? 0;
    return { id, name: inp?.name ?? id, unit: inp?.unit ?? "", from, to };
  }).filter((e) => Math.abs(e.to - e.from) > 1e-12) : [];
  // правки, которые уже ушли ИИ в этом раунде, — не новые
  const sentSame = st === "sent" && !!item?.edits && edits.length === item.edits.length && edits.every((e) => item.edits!.some((s) => s.id === e.id && Math.abs(s.to - e.to) < 1e-12));
  const draft = fx ? drafts[fx.key] ?? "" : "";
  const changed = !!draft.trim() || (edits.length > 0 && !sentSame);
  const counts = order.reduce((m, f) => { const s = stOf(rv, f.key); m[s] = (m[s] ?? 0) + 1; return m; }, {} as Record<St, number>);
  const reviewBusy = aiBusy(ai.st?.reviewStatus);

  const next = () => { if (idx < order.length - 1) setCur(order[idx + 1].key); else setCur("__end"); };
  const act = () => {
    if (!fx) return;
    if (!changed && st === "sent") { next(); return; }
    setBusy(true); setErr(null);
    rpc.call("review_submit", {
      file, release, key: fx.key, name: fx.name, comment: draft, edits,
      before: monthExp(fx), after: edits.length ? monthExp(nowFx) : null,
    }).then(() => {
      setBusy(false);
      setDrafts((d) => { const n = { ...d }; delete n[fx.key]; return n; });
      void ai.refresh();
      next();
    }, (e: unknown) => { setBusy(false); setErr(errText(e)); });
  };
  const mainLabel = busy ? "Сохраняю…" : changed ? "Отправить ИИ и дальше" : st === "sent" ? "Дальше" : "Принять и дальше";
  const threadId = rv?.threadId ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border-seam px-5 pb-2.5 pt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button variant="ghost" size="sm" onClick={onExit}><Icon name="ArrowLeft" fallback="ChevronLeft" /> Выйти из ревью</Button>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight">Ревью фич · релиз {ddmm(release)}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {cur === "__end" ? "Итог ревью" : fx ? <>Фича {idx + 1} из {order.length}</> : "…"}
              {fetching ? " · обновляю числа…" : ""}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            {(["accepted", "sent", "done", "question", "none"] as St[]).filter((s) => counts[s]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5"><Swatch st={s} className="h-2.5 w-3" />{ST[s].short} <b className="tabular-nums text-foreground">{counts[s]}</b></span>
            ))}
            {threadId && (
              <Button variant="outline" size="sm" onClick={() => onOpenThread(threadId)}>
                {reviewBusy && <span className="inline-block size-1.5 animate-pulse rounded-full" style={{ background: AI_C }} />} Тред ИИ{ai.st?.reviewStatus ? ` · ${threadWord(ai.st.reviewStatus)}` : ""}
              </Button>
            )}
          </div>
        </div>
        <div className="mt-2.5 flex gap-[3px]" role="tablist" aria-label="Фичи релиза">
          {order.map((f, i) => {
            const s = stOf(rv, f.key);
            return (
              <button key={f.key} type="button" role="tab" aria-selected={f.key === cur} onClick={() => setCur(f.key)} title={`${i + 1}. ${f.name} — ${ST[s].label}`}
                className={cn("h-2.5 min-w-[6px] flex-1 rounded-sm transition-[height,outline]", f.key === cur ? "outline outline-2 outline-offset-2 outline-foreground" : "hover:opacity-80")}
                style={ST[s].hatch ? { backgroundImage: `repeating-linear-gradient(45deg, ${ST[s].c} 0 1.5px, transparent 1.5px 4.5px)` } : { background: ST[s].c, boxShadow: s === "none" ? undefined : `0 0 6px ${mixC(ST[s].c, 60)}` }} />
            );
          })}
        </div>
      </header>

      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[1320px] px-5 py-5">
          {cur === "__end" ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border p-4">
                <h3 className="text-base font-semibold">Ревью пройдено</h3>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Принято {counts.accepted ?? 0} из {order.length}.{counts.sent ? ` У ИИ в работе ${counts.sent}: когда он закончит, фича станет «ИИ доработал».` : ""}{(counts.done ?? 0) + (counts.question ?? 0) ? ` Посмотреть снова: ${(counts.done ?? 0) + (counts.question ?? 0)}.` : ""}{counts.none ? ` Не смотрели: ${counts.none}.` : ""}
                </p>
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                {order.map((f, i) => {
                  const s = stOf(rv, f.key), it = rv?.items?.[f.key];
                  return (
                    <button key={f.key} type="button" onClick={() => setCur(f.key)}
                      className="flex w-full items-start gap-3 border-t border-border-seam px-3 py-2 text-left text-[12.5px] first:border-t-0 hover:bg-state-hover">
                      <span className="w-6 shrink-0 pt-0.5 text-right tabular-nums text-subtle-foreground">{i + 1}</span>
                      <Swatch st={s} className="mt-1 h-2.5 w-3 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{f.name}</span>
                        {it?.ai_note && <span className="block text-[11.5px] text-muted-foreground">ИИ: {it.ai_note}</span>}
                        {!it?.ai_note && it?.comment && <span className="block truncate text-[11.5px] text-subtle-foreground">Вы: «{it.comment}»</span>}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">{ST[s].short}</span>
                      <b className="w-14 shrink-0 text-right tabular-nums">{thv(monthExp(f))}</b>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={onExit}>Выйти из ревью</Button>
                {!askReset ? <Button variant="ghost" onClick={() => setAskReset(true)}>Начать ревью заново</Button> : (
                  <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px]">
                    Все статусы станут «не смотрели», прошлое ревью сохранится в файле.
                    <Button variant="outline" size="sm" onClick={() => rpc.call("review_reset", { release }).then(() => { setAskReset(false); void ai.refresh().then(() => setCur(order[0]?.key ?? "__end")); }, (e: unknown) => setErr(errText(e)))}>Да, заново</Button>
                    <Button variant="ghost" size="sm" onClick={() => setAskReset(false)}>Отмена</Button>
                  </span>
                )}
              </div>
            </div>
          ) : fx ? renderFeature(fx.key) : <p className="text-sm text-muted-foreground">В релизе нет оценённых фич.</p>}
        </div>
      </main>

      {cur !== "__end" && fx && (
        <footer className="shrink-0 border-t border-border bg-background px-5 py-3">
          <div className="mx-auto flex w-full max-w-[1320px] flex-wrap items-end gap-x-4 gap-y-2">
            <div className="min-w-[320px] flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                <Swatch st={st} className="h-2.5 w-3" />
                <b>{ST[st].label}</b>
                <span className="text-muted-foreground">
                  {st === "accepted" && when(item?.at)}
                  {st === "sent" && <>с {when(item?.at)} · раунд {item?.round}{ai.st?.reviewStatus === "error" || ai.st?.reviewStatus === "gone" ? " · тред ИИ остановился — откройте его" : ""}</>}
                  {(st === "done" || st === "question") && <>{when(item?.ai_at)} · раунд {item?.round}</>}
                </span>
                {(st === "sent" || st === "done" || st === "question") && threadId && (
                  <button type="button" onClick={() => onOpenThread(threadId)} className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">открыть тред</button>
                )}
              </div>
              {(st === "done" || st === "question") && item?.ai_note && (
                <p className={cn("rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug", st === "question" ? "border border-destructive-text/50" : "bg-surface-recessed")}>
                  {st === "question" ? "Вопрос ИИ: " : "ИИ: "}{item.ai_note}
                  {st === "done" && <span className="block text-[11.5px] text-subtle-foreground">Числа выше — из обновлённого конфига. Нет замечаний — «Принять и дальше».</span>}
                </p>
              )}
              {st === "sent" && (item?.comment || item?.edits?.length) && (
                <p className="text-[12px] text-muted-foreground">
                  Ушло ИИ: {item?.edits?.map((e) => `«${e.name}» ${fmtV(e.from, e.unit)} → ${fmtV(e.to, e.unit)}`).join("; ")}{item?.edits?.length && item?.comment ? "; " : ""}{item?.comment ? `«${item.comment}»` : ""}
                </p>
              )}
              <textarea value={draft} onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [fx.key]: v })); }} rows={2}
                placeholder={st === "question" ? "Ответ ИИ на вопрос" : "Комментарий для ИИ: что поменять в оценке. Пусто и без правок входов — фича принята"}
                className="block w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] leading-snug outline-none placeholder:text-subtle-foreground focus:border-foreground/40" />
              <div className="flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted-foreground">
                {edits.length > 0 ? (
                  <>
                    <span>
                      {sentSame ? "Правки входов уже у ИИ" : <>Изменено входов: <b className="text-foreground">{edits.length}</b> — уйдут ИИ вместе с комментарием</>}
                      {" "}· фича в месяц {thv(monthExp(fx))} → <b className="tabular-nums text-foreground">{thv(monthExp(nowFx))}</b> тыс.
                    </span>
                    <button type="button" onClick={() => clearOv(fx.key)} className="underline-offset-2 hover:text-foreground hover:underline">вернуть входы</button>
                  </>
                ) : <span>Числа входов можно менять прямо в карточках выше: правка уйдёт ИИ и попадёт в конфиг.</span>}
              </div>
              {err && <p className="text-[12px] text-destructive-text">{err}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" disabled={idx <= 0 || busy} onClick={() => setCur(order[idx - 1].key)}><Icon name="ChevronLeft" /> Назад</Button>
              <Button disabled={busy} onClick={act} className="min-w-[200px]">
                {mainLabel} <Icon name="ChevronRight" />
              </Button>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
