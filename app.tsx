// Выручка фич — панель bb: сводка релиза, путь числа по фиче, «что если», шпаргалка методики v3.
// Числа — калькулятор проекта build.py (через server.ts). Макет утверждён PO 17.11.2026.
// Стиль: токены темы bb (без dark:). С 19.11.2026 — стиль B «Категории»: цвет — строка финотчёта, роли — токены bb (FR_CSS).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AiActions, ReviewMode, useAi } from "./review";

type H = "month" | "cy" | "ny";
type S = "neg" | "exp" | "pos";
type Inputs = Record<string, Record<string, number>>;
type Rel = { key: string; file: string; release: string | null; group: "jira" | "snap"; label: string; name: string; v3: boolean; features: number; planned: string | null };
type Data = any;
type Fx = any;

const PANEL = "feature-revenue";
const MINUS = "−";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 1.5px, transparent 1.5px 4.5px)" };
const MONEY_RU: Record<string, string> = { spend: "траты", topup: "пополнения", direct: "прямые" };
const CONF_N: Record<string, number> = { высокая: 3, средняя: 2, низкая: 1 };
const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

// ---------- форматы ----------
function grp(n: number) {
  return Math.abs(n).toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}
/** тыс. сом, целые, со знаком */
function th(v: number | null | undefined, sign = true) {
  if (v == null || !Number.isFinite(v)) return "—";
  const n = Math.round(v / 1000);
  if (n === 0) return "0";
  return n < 0 ? MINUS + grp(n) : (sign ? "+" : "") + grp(n);
}
/** тыс. сом со знаком в цвете: плюс — зелёный, минус — красный, 0 — без цвета */
function Th({ v }: { v: number | null | undefined }) {
  const n = v == null || !Number.isFinite(v) ? 0 : Math.round(v / 1000);
  return <span className={n > 0 ? "text-success" : n < 0 ? "text-destructive-text" : undefined}>{th(v)}</span>;
}
function num(v: number, digits = 4) {
  const s = (+v.toFixed(digits)).toString().replace(".", ",");
  return s.startsWith("-") ? MINUS + s.slice(1) : s;
}
function pct(v: number) {
  return num(v * 100, 2) + "%";
}
/** значение входа с единицей */
function fv(v: number | null | undefined, unit: string) {
  if (v == null) return "—";
  if (unit === "доля") return pct(v);
  return Math.abs(v) >= 1000 ? (v < 0 ? MINUS : "") + grp(v) : num(v);
}
function unitOf(unit: string) {
  return unit === "доля" ? "" : unit;
}
function dmy(iso: string | null | undefined) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}
function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
function dm(iso: string | null | undefined) {
  return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "—";
}
/** «2026-11-18T12:02» -> «18.11.2026, 12:02» */
function jiraAt(iso: string | null | undefined) {
  if (!iso) return "—";
  return `${dmy(iso)}${iso.length > 10 ? `, ${iso.slice(11, 16)}` : ""}`;
}
/** по статусу эпика деньги ждём позже релиза, который стоит в Jira */
const slipOf = (f: Fx): string | null => (f.jira?.planned && f.release?.exp && f.release.exp !== f.jira.planned ? f.release.exp : null);
function hLabel(h: H, d: Data) {
  return h === "month" ? "в месяц" : `за ${h === "cy" ? d._meta.cy : d._meta.ny}`;
}
function niceStep(range: number) {
  const raw = range / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}
function scale(values: number[], pad = 0.06) {
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (hi - lo < 1) hi = lo + 1;
  const span = hi - lo;
  lo -= span * pad;
  hi += span * pad;
  const X = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const step = niceStep((hi - lo) / 1000) * 1000;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(Math.round(t));
  return { X, ticks };
}
const fval = (fx: Fx, h: H, s: S): number => fx.vals?.[h]?.[s] ?? 0;
/** минус к выручке: ожидаемый эффект после округления до тыс. сом меньше 0 — так же, как красное число у Th */
const isNeg = (v: number | null | undefined) => v != null && Number.isFinite(v) && Math.round(v / 1000) < 0;
/** подсветка строки фичи с минусом: красный фон и полоса слева */
const NEG_ROW = "bg-destructive/10 shadow-[inset_3px_0_0_var(--destructive-text)] hover:bg-destructive/15";
const NEG_TIP = "Ожидаемый эффект на выручку — минус";
function NegTag({ label = "минус" }: { label?: string }) {
  return <span className="shrink-0 whitespace-nowrap rounded bg-destructive/10 px-1 text-[10.5px] font-medium leading-4 text-destructive-text" title={NEG_TIP}>{label}</span>;
}
const nonzero = (fx: Fx) => fx.has && (["neg", "exp", "pos"] as S[]).some((s) => Math.abs(fval(fx, "month", s)) > 0.5 || Math.abs(fval(fx, "ny", s)) > 0.5);

// ---------- мелкие элементы ----------
function Conf({ c }: { c: string }) {
  const n = CONF_N[c] ?? 0;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={`уверенность: ${c}`}>
      {[0, 1, 2].map((i) => (
        <i key={i} className="inline-block size-1.5 rounded-full border" style={{ borderColor: CONF_C[c] ?? "var(--muted-foreground)", background: i < n ? (CONF_C[c] ?? "var(--muted-foreground)") : "transparent" }} />
      ))}
    </span>
  );
}
function Lvl({ level }: { level: string }) {
  const n = Number(level?.[1] ?? 0);
  return (
    <span className="inline-flex shrink-0 items-end gap-1 rounded border border-border px-1.5 py-px text-[11px] font-semibold" title={`уровень доказательства ${level}`}>
      {level || "—"}
      <span className="inline-flex items-end gap-px pb-px">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} className={cn("inline-block w-[3px]", !(i >= n - 1 && n > 0) && "bg-foreground/15")} style={{ height: 4 + (4 - i) * 2, ...(i >= n - 1 && n > 0 ? { background: n <= 2 ? C_POS : n === 3 ? C_ATT : C_WARN } : {}) }} />
        ))}
      </span>
    </span>
  );
}
const MAIN_TIP = "Главный вход: сильнее всего двигает итог фичи. Уверенность фичи — по его уровню";
function MainStar() {
  return <span className="mr-1 font-semibold" style={{ color: C_ATT }} title={MAIN_TIP} aria-label="главный вход">★</span>;
}
function Chip({ children, dashed }: { children: ReactNode; dashed?: boolean }) {
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-border px-1.5 py-px text-[11.5px] text-muted-foreground", dashed && "border-dashed")}>{children}</span>;
}
function Seg<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={cn("inline-flex overflow-hidden rounded-md border border-border", disabled && "opacity-50")}>
      {options.map((o, i) => (
        <button key={String(o.v)} type="button" disabled={disabled} onClick={() => onChange(o.v)}
          className={cn("whitespace-nowrap px-2.5 py-1 text-[12.5px] transition-colors", i > 0 && "border-l border-border", value === o.v ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
function Block({ title, hint, children, className, id, sref }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; id?: string; sref?: (el: HTMLElement | null) => void }) {
  return (
    <section id={id} ref={sref} className={cn("scroll-mt-4 rounded-lg border border-border p-4", className)}>
      <h3 className="mb-3 text-[13.5px] font-semibold leading-snug">
        {title}
        {hint && <span className="ml-2 text-xs font-normal text-subtle-foreground">{hint}</span>}
      </h3>
      {children}
    </section>
  );
}
function Metric({ label, children, note, off }: { label: string; children: ReactNode; note?: ReactNode; off?: boolean }) {
  return (
    <div className={cn("rounded-lg px-4 py-3", off ? "border border-dashed border-border" : "bg-surface-recessed")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 whitespace-nowrap text-2xl font-semibold tabular-nums tracking-tight", off && "text-subtle-foreground")}>{children}</div>
      {note && <div className="mt-1.5 text-[11.5px] leading-snug text-subtle-foreground">{note}</div>}
    </div>
  );
}
function Row({ label, value, muted }: { label: ReactNode; value: ReactNode; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 border-t border-border-seam py-1.5 text-[12.5px]", muted && "text-subtle-foreground")}>
      <span className="min-w-0 truncate">{label}</span>
      <b className="shrink-0 tabular-nums">{value}</b>
    </div>
  );
}
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg bg-surface-recessed px-3 py-2 text-[12.5px] text-muted-foreground">
      <Icon name="Info" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
function Triple({ neg, exp, pos, inverse }: { neg: ReactNode; exp: ReactNode; pos: ReactNode; inverse?: boolean }) {
  const cell = (k: string, v: ReactNode, m?: boolean) => (
    <span className={cn("flex-1 rounded border px-1 py-0.5 text-center text-[10px] leading-tight", inverse ? "border-background/30 text-background/70" : "border-border text-subtle-foreground", m && (inverse ? "bg-background/20" : "bg-state-active"))}>
      {k}
      <b className={cn("block text-[12px] tabular-nums", inverse ? "text-background" : "text-foreground")}>{v}</b>
    </span>
  );
  return <div className="flex gap-1">{cell("негатив", neg)}{cell("ожидаем", exp, true)}{cell("позитив", pos)}</div>;
}

// ---------- Стиль B «Категории» (редизайн 19.11.2026, решение PO): цвет — строка финотчёта ----------
// Роли — токены bb, меняются с темой bb. Цвета строк — свои переменные для светлой и тёмной темы;
// .dark — класс bb на <html>, не тема Windows (поэтому не dark:).
const FR_CSS = `
.fr-root{--fr-pop:oklch(56% .11 215);--fr-promo:oklch(52% .2 300);--fr-rep:oklch(52% .17 258);--fr-cred:oklch(56% .19 355);--fr-biz:oklch(60% .16 50);--fr-b2b:oklch(58% .16 130);--fr-4s:oklch(55% .05 250);--fr-pub:oklch(56% .1 180);--fr-x1:oklch(56% .15 25);--fr-x2:oklch(56% .12 95);--fr-info:oklch(52% .15 250);--fr-att:oklch(58% .15 75);--fr-on:oklch(99% 0 0)}
.dark .fr-root{--fr-pop:oklch(78% .12 205);--fr-promo:oklch(70% .17 300);--fr-rep:oklch(70% .14 258);--fr-cred:oklch(72% .16 350);--fr-biz:oklch(76% .14 55);--fr-b2b:oklch(84% .16 125);--fr-4s:oklch(66% .04 250);--fr-pub:oklch(76% .11 178);--fr-x1:oklch(74% .13 25);--fr-x2:oklch(80% .12 95);--fr-info:oklch(72% .12 250);--fr-att:var(--attention);--fr-on:oklch(18% 0 0)}
.fr-range{-webkit-appearance:none;appearance:none;background:transparent;height:18px;margin:0;cursor:pointer}
.fr-range::-webkit-slider-runnable-track{height:18px;background:transparent}
.fr-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:2px;border-radius:50%;background:var(--fr-thumb,var(--foreground));border:2px solid var(--background);box-shadow:0 0 0 1px var(--fr-thumb,var(--foreground)),0 0 8px var(--fr-thumb,var(--foreground))}
`;
const C_POS = "var(--success)", C_NEG = "var(--destructive-text)", C_ATT = "var(--fr-att)", C_WARN = "var(--warning-text)", C_AI = "var(--pr-merged)", C_INFO = "var(--fr-info)";
const tint = (c: string, p: number) => `color-mix(in oklab, ${c} ${p}%, transparent)`;
const LINE_VAR: Record<string, string> = { "Пополнения": "pop", "Промо": "promo", "Отчёты": "rep", "Кредиты MBANK": "cred", "Бизнес-аккаунты": "biz", "Новая: B2B": "b2b", "4 услуги": "4s", "Публикации": "pub" };
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function lineColor(line: string | null | undefined): string {
  if (!line) return "var(--muted-foreground)";
  const k = LINE_VAR[line] ?? (line.startsWith("Пополнения") ? "pop" : line.startsWith("Кредиты") ? "cred" : line.startsWith("Промо") ? "promo" : null);
  if (k) return `var(--fr-${k})`;
  let x = 0;
  for (const ch of line) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--fr-${x % 2 ? "x1" : "x2"})`;
}
const shortLine = (l: string) => l.replace("Новая: ", "").replace(" MBANK", "");
/** строки финотчёта фичи — по частям, сначала самая весомая */
function linesOf(f: Fx): string[] {
  const m = new Map<string, number>();
  for (const c of f.components ?? []) if (c.line) m.set(c.line, (m.get(c.line) ?? 0) + Math.abs(c.month?.exp ?? 0) + 1e-9);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}
const stripeBg = (ls: string[]) => (ls.length > 1 ? `linear-gradient(180deg, ${ls.map(lineColor).join(", ")})` : lineColor(ls[0]));
/** сумма частей фич по строкам финотчёта за период */
function lineSums(all: Fx[], h: H) {
  const m = new Map<string, number>();
  for (const f of all) for (const c of f.components ?? []) {
    const v = compVal(c, h, "exp");
    if (Math.abs(v) < 0.5) continue;
    const l = c.line || "без строки";
    m.set(l, (m.get(l) ?? 0) + v);
  }
  return [...m.entries()].map(([line, v]) => ({ line, v }));
}
type IssId = "minus" | "sign" | "late" | "chk" | "met" | "nomet";
const ISS: Record<IssId, { label: string; chip: string; c: string; tip: string }> = {
  minus: { label: "минус", chip: "Минус", c: C_NEG, tip: "Ожидаемый эффект — минус к выручке: запускать, смягчить или запускать тестом" },
  sign: { label: "знак?", chip: "Знак не ясен", c: C_ATT, tip: "Вилка от минуса до плюса, главный вход — бенчмарк или экспертно: нужен тест или данные до релиза" },
  late: { label: "срок", chip: "Срок отстаёт", c: C_INFO, tip: "По статусу Jira деньги позже релиза: перенести релиз в Jira или ускорить" },
  chk: { label: "проверки", chip: "Проверки", c: C_WARN, tip: "Сработали проверки калькулятора: исправить или записать причину" },
  met: { label: "метрика", chip: "Метрика — черновик", c: C_AI, tip: "Метрика замера — черновик ИИ: проверить метрику и способ до релиза" },
  nomet: { label: "нет метрики", chip: "Нет метрики", c: C_AI, tip: "Нет метрики замера: до релиза записать, что смотрим и сколько ждём" },
};
const ISS_ORDER: IssId[] = ["minus", "sign", "late", "chk", "met", "nomet"];
const CONF_C: Record<string, string> = { высокая: C_POS, средняя: C_ATT, низкая: C_WARN };
function checksOf(d: Data, key: string): any[] {
  return (d?._checks ?? []).filter((c: any) => typeof c.where === "string" && (c.where === key || c.where.startsWith(key + " ")));
}
/** что решить по фиче: те же правила, что были в блоке «Что решить» */
function issuesOf(f: Fx, d: Data, h: H): { id: IssId; n?: number }[] {
  if (!nonzero(f)) return [];
  const out: { id: IssId; n?: number }[] = [];
  const m = f.inputs?.find((x: any) => x.id === f.main_input);
  if (isNeg(fval(f, h, "exp"))) out.push({ id: "minus" });
  if (fval(f, "month", "exp") >= -0.5 && fval(f, "month", "neg") < -0.5 && fval(f, "month", "pos") > 0.5 && (m?.level === "У4" || m?.level === "У5")) out.push({ id: "sign" });
  if (d?._meta?.pool && slipOf(f)) out.push({ id: "late" });
  const nc = checksOf(d, f.key).length;
  if (nc) out.push({ id: "chk", n: nc });
  if (!f.measure) out.push({ id: "nomet" });
  else if (f.measure.draft) out.push({ id: "met" });
  return out;
}
function Pill({ c, children, dot, title }: { c: string; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium leading-5" style={{ background: tint(c, 16), color: c }}>
      {dot && <i className="inline-block size-1.5 rounded-full" style={{ background: c }} />}{children}
    </span>
  );
}
function IssChip({ id, n }: { id: IssId; n?: number }) {
  const x = ISS[id];
  return <span title={x.tip} className="inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 text-[10.5px] font-semibold leading-[18px]" style={{ background: tint(x.c, 16), color: x.c }}>{x.label}{n ? ` ${n}` : ""}</span>;
}
function ConfDots({ c, word }: { c: string; word?: boolean }) {
  const n = CONF_N[c] ?? 0, col = CONF_C[c] ?? "var(--muted-foreground)";
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px]" title={`уверенность: ${c}`}>
      {[0, 1, 2].map((i) => <i key={i} className="inline-block size-[7px] rounded-full bg-foreground/15" style={i < n ? { background: col, boxShadow: `0 0 5px ${col}` } : undefined} />)}
      {word && <span className="ml-1 text-[11px] text-muted-foreground">{c}</span>}
    </span>
  );
}
function FilterChip({ on, c, dot, title, onClick, label, count }: { on?: boolean; c: string; dot?: boolean; title?: string; onClick: () => void; label: ReactNode; count?: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="inline-flex h-[30px] items-center gap-2 whitespace-nowrap rounded-full border px-3 text-[12.5px] text-foreground transition-colors"
      style={{ borderColor: on ? c : tint(c, 40), background: tint(c, on ? 28 : 9), boxShadow: on ? `0 0 0 1px ${c}, 0 0 14px ${tint(c, 40)}` : undefined }}>
      {dot && <i className="inline-block size-2 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />}
      {label}{count != null && <b className="font-bold tabular-nums" style={{ color: c }}>{count}</b>}
    </button>
  );
}
function Kpi({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border-seam px-3 py-2.5" style={{ background: tint("var(--foreground)", 4) }}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 whitespace-nowrap text-[19px] font-bold tabular-nums">{children}</div>
      {note && <div className="mt-0.5 text-[11px] leading-snug text-subtle-foreground">{note}</div>}
    </div>
  );
}
function KpiCard({ label, value, note, c }: { label: string; value: ReactNode; note?: ReactNode; c: string }) {
  return (
    <div className="rounded-xl border border-border-seam px-4 py-3" style={{ background: `linear-gradient(180deg, ${tint(c, 10)}, transparent 80%)` }}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[22px] font-bold tabular-nums" style={{ color: c }}>{value}</div>
      {note && <div className="mt-0.5 text-[11.5px] leading-snug text-subtle-foreground">{note}</div>}
    </div>
  );
}
/** крупное число: плюс — градиент зелёный → бирюзовый, минус — красный со свечением */
function bigStyle(e: number): CSSProperties {
  const n = Math.round(e / 1000);
  return n > 0
    ? { backgroundImage: "linear-gradient(90deg, var(--success), var(--fr-pop) 75%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 0 22px ${tint("var(--fr-pop)", 35)})` }
    : n < 0 ? { color: C_NEG, textShadow: `0 0 22px ${tint(C_NEG, 45)}` } : { color: "var(--muted-foreground)" };
}
const shortName = (n: string, max = 24) => { const x = String(n ?? "").split(":")[0].trim(); return x.length > max ? x.slice(0, max - 1) + "…" : x; };
const iceStyle = (v: number): CSSProperties => (v > 0 ? { background: tint(C_POS, Math.min(40, 8 + v / 8)) } : v < 0 ? { background: tint(C_NEG, v < -500 ? 40 : 22) } : {});
function Countdown({ d }: { d: Data }) {
  const rf: string | undefined = d?._meta?.release_filter, at: string | undefined = d?._meta?.assessed;
  if (!d?._meta?.pool || !rf || rf.length !== 10 || !at) return null;
  const days = Math.round((Date.parse(rf) - Date.parse(at.slice(0, 10))) / 86_400_000);
  return <Pill c={C_INFO} title={`Релиз ${dmy(rf)}, данные Jira на ${dmy(at)}`}>{days > 0 ? `через ${days} дн.` : days === 0 ? "сегодня" : "вышел"}</Pill>;
}

function Hero({ d, h, all }: { d: Data; h: H; all: Fx[] }) {
  const T = d._total, R = d._range, L = d._total_late, F = d._fin_total, meta = d._meta;
  const finOk = meta.v3 && meta.k_config != null;
  const e = T[h].exp;
  const conf = { низкая: 0, средняя: 0, высокая: 0 } as Record<string, number>;
  for (const f of all.filter(nonzero)) if (f.confidence in conf) conf[f.confidence]++;
  const sums = lineSums(all, h);
  const pos = sums.filter((x) => x.v > 0.5).sort((a, b) => b.v - a.v), neg = sums.filter((x) => x.v < -0.5);
  const negS = -neg.reduce((s, x) => s + x.v, 0), tot = negS + pos.reduce((s, x) => s + x.v, 0);
  const rf: string = String(meta.release_filter ?? "");
  const big: CSSProperties = Math.round(e / 1000) > 0
    ? { backgroundImage: "linear-gradient(90deg, var(--success), var(--fr-pop) 75%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 0 22px ${tint("var(--fr-pop)", 35)})` }
    : Math.round(e / 1000) < 0 ? { color: C_NEG, textShadow: `0 0 22px ${tint(C_NEG, 45)}` } : { color: "var(--muted-foreground)" };
  return (
    <section className="relative overflow-hidden rounded-xl border px-5 py-4"
      style={{ borderColor: tint("var(--fr-promo)", 30), background: `radial-gradient(600px 260px at 0% 0%, ${tint("var(--fr-pop)", 15)}, transparent 70%), radial-gradient(600px 260px at 100% 100%, ${tint("var(--fr-promo)", 15)}, transparent 70%)` }}>
      <div className="grid grid-cols-1 items-center gap-4 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,660px)]">
        <div>
          <div className="text-xs text-muted-foreground">Ожидаем {/^\d{4}-/.test(rf) ? `от релиза ${dm(rf)}` : "от фич"}, {hLabel(h, d)}{h === "month" ? " на полном разгоне" : ""}</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="text-[50px] font-bold leading-none tracking-tight tabular-nums" style={big}>{th(e)}</span>
            <span className="text-[15px] text-muted-foreground">тыс. сом</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
          <Kpi label="Вилка релиза" note="хуже / лучше — 1 из 10"><Th v={R[h].neg} /> … <Th v={R[h].pos} /></Kpi>
          <Kpi label="Итог финотчёта" note={finOk ? `траты × k ${Math.round(meta.k_used * 100)}% + пополнения + прямые` : meta.v3 ? "нет k: не заданы строки" : "конфиг до методики v3"}>{finOk ? <Th v={F[h].exp} /> : <span className="text-subtle-foreground">нет</span>}</Kpi>
          <Kpi label="За год" note={`${meta.cy} / ${meta.ny} · если релизы сдвинутся: ${th(L.cy)} / ${th(L.ny)}`}><Th v={T.cy.exp} /> <span className="text-[13px] font-normal text-subtle-foreground">/</span> <Th v={T.ny.exp} /></Kpi>
          <Kpi label="Уверенность" note={`низк. ${conf.низкая} · средн. ${conf.средняя} · выс. ${conf.высокая}`}>
            <div className="mb-1 mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
              {conf.низкая > 0 && <i style={{ flex: conf.низкая, background: C_WARN }} />}
              {conf.средняя > 0 && <i style={{ flex: conf.средняя, background: C_ATT }} />}
              {conf.высокая > 0 && <i style={{ flex: conf.высокая, background: C_POS }} />}
            </div>
          </Kpi>
        </div>
      </div>
      {tot > 0.5 && (
        <>
          <div className="mt-4 text-[11.5px] text-muted-foreground">Из чего складывается: строки финотчёта, тыс. сом {hLabel(h, d)}</div>
          <div className="mt-1.5 flex h-7 gap-0.5 overflow-hidden rounded-lg">
            {negS > 0.5 && (
              <div title={neg.map((x) => `${x.line} ${th(x.v)}`).join(" · ")} className="flex items-center justify-center text-[11.5px] font-bold text-foreground"
                style={{ flex: negS, minWidth: 38, backgroundImage: `repeating-linear-gradient(135deg, ${tint(C_NEG, 75)} 0 4px, ${tint(C_NEG, 25)} 4px 8px)` }}>{th(-negS)}</div>
            )}
            {pos.map((x) => {
              const share = x.v / tot;
              return (
                <div key={x.line} title={`${x.line} ${th(x.v)}`} className="flex items-center justify-center overflow-hidden whitespace-nowrap px-1 text-[11.5px] font-bold"
                  style={{ flex: x.v, background: lineColor(x.line), color: "var(--fr-on)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)" }}>
                  {share > 0.12 ? `${shortLine(x.line)} ${th(x.v)}` : share > 0.045 ? th(x.v) : ""}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function LineCard({ r, m, on, onClick }: { r: PlanLine; m: string; on: boolean; onClick: () => void }) {
  const c = lineColor(r.line), e = r.vals.exp;
  const plan = r.plan?.[m];
  const need = plan != null && r.base != null ? plan - r.base : null;
  const share = need != null && need > 0 ? e / need : null;
  const small = r.noise != null && r.base != null && Math.abs(e) > 0.5 && Math.abs(e) < r.noise * r.base;
  return (
    <button type="button" onClick={onClick} data-fr-line={r.line}
      title={`${r.line}: база ${r.base != null ? th(r.base, false) : "—"}, план ${plan != null ? th(plan, false) : "—"}, фичи ${th(e)} (вилка ${th(r.vals.neg)} … ${th(r.vals.pos)}). Клик — фичи строки`}
      className="relative overflow-hidden rounded-xl border px-3 pb-2 pt-2.5 text-left transition-colors hover:bg-state-hover"
      style={{ borderColor: on ? c : "var(--border-seam)", background: `linear-gradient(180deg, ${tint(c, on ? 26 : 12)}, transparent 72%)`, boxShadow: on ? `0 0 0 1px ${c}, 0 0 16px ${tint(c, 40)}` : undefined }}>
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: c, boxShadow: `0 0 10px ${c}` }} />
      <div className="truncate text-[12px] font-semibold">{r.line}</div>
      <div className="mt-0.5 text-[19px] font-bold tabular-nums"><Th v={e} /></div>
      {share != null
        ? <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-foreground/10"><div className="h-full rounded-full" style={{ width: `${Math.max(Math.abs(e) > 0.5 ? 3 : 0, Math.min(100, Math.abs(share) * 100))}%`, background: share < 0 ? C_NEG : c, boxShadow: `0 0 6px ${c}` }} /></div>
        : <div className="mt-1.5 h-[5px] rounded-full" style={{ backgroundImage: "repeating-linear-gradient(90deg, var(--border) 0 4px, transparent 4px 7px)" }} />}
      <div className="mt-1 flex justify-between gap-1 whitespace-nowrap text-[10.5px] text-muted-foreground">
        <span className={share != null && share < 0 ? "text-destructive-text" : undefined}>{share != null ? `${share < 0 ? MINUS : ""}${num(Math.abs(share) * 100, 1)}% к плану` : need == null ? "нет плана" : need <= 0 ? "план ниже базы" : "—"}</span>
        {small && <span style={{ color: C_WARN }} title="Эффект меньше обычного колебания строки: без A/B не измерить">в шуме</span>}
      </div>
    </button>
  );
}

function LineCards({ d, sel, onSel }: { d: Data; sel: string | null; onSel: (l: string | null) => void }) {
  const rows: PlanLine[] = d._plan_lines ?? [];
  const months = [...new Set(rows.flatMap((r) => Object.keys(r.plan ?? {})))].sort();
  const relM = String(d._meta.release_filter ?? "").slice(0, 7);
  const [m, setM] = useState<string>(months.includes(relM) ? relM : months[0] ?? "");
  const [table, setTable] = useState(false);
  if (!rows.length) return null;
  const cover = d._plan_cover?.[m];
  const list = [...rows].sort((a, b) => b.vals.exp - a.vals.exp);
  const mi = m ? Number(m.slice(5, 7)) - 1 : -1;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-semibold">Строки финотчёта{mi >= 0 ? ` · план ${MONTHS_GEN[mi]}` : ""}</h3>
        {cover?.share != null && (
          <span className="text-[12px] text-muted-foreground" title={`Нужно прирасти по строкам с планом выше базы: ${(cover.lines ?? []).join(", ")}`}>
            фичи закрывают <b style={{ color: cover.share > 0 ? C_ATT : C_NEG }}>{cover.share < 0 ? MINUS : ""}{num(Math.abs(cover.share) * 100, 1)}%</b> разрыва: <span className="tabular-nums">{th(cover.give)} из {th(cover.need, false)}</span>
          </span>
        )}
        <span className="text-[11.5px] text-subtle-foreground">тыс. сом в месяц · клик по строке — её фичи</span>
        <div className="ml-auto flex items-center gap-2">
          {months.length > 1 && <Seg value={m} onChange={setM} options={months.map((k) => ({ v: k, label: MONTHS_RU[Number(k.slice(5, 7)) - 1] }))} />}
          <Button variant="ghost" size="sm" onClick={() => setTable(!table)}><Icon name={table ? "ChevronDown" : "ChevronRight"} /> таблица</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4 @6xl:grid-cols-8">
        {list.map((r) => <LineCard key={r.line} r={r} m={m} on={sel === r.line} onClick={() => onSel(sel === r.line ? null : r.line)} />)}
      </div>
      {table && <PlanBlock d={d} />}
    </section>
  );
}

const ROWC = "grid grid-cols-[minmax(0,1fr)_minmax(80px,170px)_50px_minmax(0,190px)_52px] items-center gap-x-2 @5xl:grid-cols-[minmax(0,1fr)_64px_100px_minmax(120px,220px)_50px_84px_minmax(0,230px)_56px]";
function FxRow({ f, d, h, X, iss, onClick }: { f: Fx; d: Data; h: H; X: (v: number) => number; iss: { id: IssId; n?: number }[]; onClick: () => void }) {
  const n = fval(f, h, "neg"), e = fval(f, h, "exp"), p = fval(f, h, "pos");
  const a = Math.min(n, p), b = Math.max(n, p);
  const ls = linesOf(f), c0 = lineColor(ls[0]);
  const neg = e < -0.5;
  const slip = slipOf(f);
  const ice = d._ice?.[f.key]?.value;
  return (
    <button type="button" data-fr-row={f.key} onClick={onClick} title="Открыть карточку фичи"
      className={cn(ROWC, "relative w-full border-t border-border-seam py-2 pl-4 pr-1 text-left transition-colors hover:bg-state-hover")}
      style={isNeg(e) ? { background: `linear-gradient(90deg, ${tint(C_NEG, 13)}, transparent 55%)` } : undefined}>
      <span className="absolute bottom-1.5 left-0 top-1.5 w-[5px] rounded-full" style={{ background: stripeBg(ls), boxShadow: `0 0 8px ${c0}` }} />
      <span className="min-w-0 truncate text-[12.5px]" title={`${f.name}${ls.length ? ` · ${ls.join(", ")}` : ""}`}>{f.name}<span className="ml-1.5 text-[10.5px] text-subtle-foreground">{f.key}</span></span>
      <span className="hidden @5xl:block">{slip ? <Pill c={C_INFO} title={`В Jira релиз ${dmy(f.jira?.planned)}. По статусу «${f.status}» деньги ждём с ${dmy(slip)}`}>с {dm(slip)}</Pill> : <span className="text-[11.5px] tabular-nums text-muted-foreground">{dm(f.release?.exp)}</span>}</span>
      <span className="hidden @5xl:flex"><ConfDots c={f.confidence} word /></span>
      <span className="relative block h-6">
        <span className="absolute inset-y-0 border-l border-foreground/30" style={{ left: `${X(0)}%` }} />
        <span className="absolute top-[5px] h-3.5 rounded-full" style={{ left: `${X(a)}%`, width: `max(${X(b) - X(a)}%, 3px)`, background: tint(neg ? C_NEG : c0, 14) }} />
        <span className="absolute top-[6px] h-3 rounded-full"
          style={{ left: `${Math.min(X(0), X(e))}%`, width: `${Math.abs(X(e) - X(0))}%`, ...(neg
            ? { backgroundImage: `repeating-linear-gradient(135deg, ${C_NEG} 0 3px, ${tint(C_NEG, 30)} 3px 6px)`, boxShadow: `0 0 6px ${tint(C_NEG, 60)}` }
            : { background: ls.length > 1 ? `linear-gradient(90deg, ${ls.map(lineColor).join(", ")})` : c0, boxShadow: `0 0 6px ${tint(c0, 70)}` }) }} />
      </span>
      <b className="text-right text-[13.5px] tabular-nums"><Th v={e} /></b>
      <span className="hidden whitespace-nowrap text-[11px] tabular-nums text-muted-foreground @5xl:block">{th(n)} … {th(p)}</span>
      <span className="flex min-w-0 gap-1 overflow-hidden">{iss.map((x) => <IssChip key={x.id} id={x.id} n={x.n} />)}</span>
      <span className="rounded px-1.5 py-0.5 text-right text-[11.5px] font-bold tabular-nums" style={ice == null ? undefined : iceStyle(ice)} title="ICE = Impact × Confidence ÷ Effort">{ice == null ? "—" : `${ice < 0 ? MINUS : ""}${grp(ice)}`}</span>
    </button>
  );
}

/** шапка карточки фичи: строка финотчёта цветом, статус, уверенность, что решить, число и вилка */
function FxHead({ fx, d, h, E, N, P, baseE }: { fx: Fx; d: Data; h: H; E: number; N: number; P: number; baseE: number }) {
  const ls = linesOf(fx);
  const c0 = ls.length ? lineColor(ls[0]) : "var(--muted-foreground)";
  const iss = issuesOf(fx, d, h);
  const slip = slipOf(fx);
  const col = isNeg(E) ? C_NEG : Math.round(E / 1000) > 0 ? C_POS : "var(--muted-foreground)";
  const lo = Math.min(N, P, 0, E), hi = Math.max(N, P, 0, E), span = hi - lo || 1;
  const X = (v: number) => ((v - lo) / span) * 100;
  const a = Math.min(N, P), b = Math.max(N, P);
  const z = b > a ? Math.max(0, Math.min(100, ((0 - a) / (b - a)) * 100)) : 0;
  const band = a < 0 && b > 0 ? `linear-gradient(90deg, ${tint(C_NEG, 60)}, ${tint(C_NEG, 18)} ${z}%, ${tint(C_POS, 18)} ${z}%, ${tint(C_POS, 60)})`
    : b <= 0 ? `linear-gradient(90deg, ${tint(C_NEG, 60)}, ${tint(C_NEG, 18)})` : `linear-gradient(90deg, ${tint(C_POS, 18)}, ${tint(C_POS, 60)})`;
  return (
    <div className="relative overflow-hidden rounded-xl border border-border px-4 pb-3 pt-4" style={{ background: `linear-gradient(180deg, ${tint(c0, 14)}, transparent 75%)` }}>
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: ls.length > 1 ? `linear-gradient(90deg, ${ls.map(lineColor).join(", ")})` : c0, boxShadow: `0 0 14px ${c0}` }} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{fx.name}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip>{fx.key}</Chip>
            {ls.map((l) => <Pill key={l} c={lineColor(l)} dot>{l}</Pill>)}
            <Pill c={C_INFO} title={slip ? `В Jira релиз ${dmy(fx.jira?.planned)}, по статусу деньги позже` : undefined}>Jira: {fx.status}{slip ? ` · деньги с ${dm(slip)}` : ""}</Pill>
            {CONF_C[fx.confidence] && <span title="По главному входу (★): У1–У2 высокая, У3 средняя, У4–У5 низкая"><Pill c={CONF_C[fx.confidence]}><ConfDots c={fx.confidence} /> {fx.confidence}</Pill></span>}
          </div>
          {iss.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1"><span className="mr-1 text-[11.5px] text-muted-foreground">что решить:</span>{iss.map((x) => <IssChip key={x.id} id={x.id} n={x.n} />)}</div>}
        </div>
        <div className="text-right">
          <div className="text-[11.5px] text-muted-foreground">{hLabel(h, d)}, ожидаем</div>
          <div className="text-[36px] font-bold leading-none tabular-nums" style={{ color: col, textShadow: `0 0 22px ${tint(col, 45)}` }}>{th(E)}</div>
          <div className="mt-1 text-[11.5px] text-muted-foreground">тыс. сом{fx.has ? <> · вилка <span className="tabular-nums">{th(N)} … {th(P)}</span></> : null}</div>
          {Math.abs(E - baseE) > 0.5 && <div className="text-[11.5px] tabular-nums text-subtle-foreground">по конфигу <s>{th(baseE)}</s></div>}
        </div>
      </div>
      {fx.has && b - a > 0.5 && (
        <div className="relative mt-3 h-6" title={`Вилка ${th(N)} … ${th(P)}: хуже или лучше — в 1 случае из 10`}>
          <span className="absolute inset-x-0 top-[9px] h-1.5 rounded-full bg-foreground/10" />
          <span className="absolute top-[6px] h-3 rounded-full" style={{ left: `${X(a)}%`, width: `${X(b) - X(a)}%`, background: band }} />
          {lo < 0 && hi > 0 && <span className="absolute inset-y-0 border-l border-dashed border-foreground/40" style={{ left: `${X(0)}%` }} />}
          <span className="absolute top-0 h-6 w-[3px] -translate-x-1/2 rounded bg-foreground" style={{ left: `${X(E)}%`, boxShadow: `0 0 10px ${col}` }} />
        </div>
      )}
    </div>
  );
}

type SheetState = { kind: "fx"; key: string; list: string[]; label: string } | { kind: "checks" } | { kind: "cheat" } | null;
/** панель поверх вкладки: карточка фичи, проверки, шпаргалка — список под ней не теряется */
function Sheet({ title, head, foot, onClose, scrollKey, children }: { title?: ReactNode; head?: ReactNode; foot?: ReactNode; onClose: () => void; scrollKey?: string; children: ReactNode }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      <button type="button" aria-label="Закрыть" onClick={onClose} className="absolute inset-0 cursor-default bg-black/55" />
      <div role="dialog" className="relative flex h-full w-[min(940px,100%)] flex-col border-l border-border bg-background shadow-[-24px_0_60px_rgba(0,0,0,0.45)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-seam px-5 py-2.5">
          {head ?? <h3 className="text-[14px] font-semibold">{title}</h3>}
          <button type="button" onClick={onClose} aria-label="Закрыть" className="ml-auto flex size-8 items-center justify-center rounded-md border border-border text-[18px] leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground">×</button>
        </div>
        <div key={scrollKey} className="min-h-0 flex-1 overflow-y-auto"><div className="@container px-5 py-4">{children}</div></div>
        {foot && <div className="flex shrink-0 items-center gap-2 border-t border-border-seam bg-surface-recessed px-5 py-2.5">{foot}</div>}
      </div>
    </div>
  );
}

// ---------- Экран 1. Релиз ----------
function RangeChart({ feats, h, onPick }: { feats: Fx[]; h: H; onPick: (k: string) => void }) {
  const { X, ticks } = scale(feats.flatMap((f) => [fval(f, h, "neg"), fval(f, h, "pos"), fval(f, h, "exp")]));
  const cols = "grid grid-cols-[minmax(170px,320px)_minmax(160px,1fr)_150px] items-center gap-x-3";
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-subtle-foreground">
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-6 rounded-full bg-foreground/25" />вилка: негатив … позитив</span>
        {feats.some((f) => isNeg(fval(f, h, "exp"))) && <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-6 rounded-sm bg-destructive/10 shadow-[inset_3px_0_0_var(--destructive-text)]" />минус к выручке</span>}
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3.5 w-1 rounded bg-foreground" />ожидаем</span>
        <span className="inline-flex items-center gap-1.5" title="По главному входу (★) — тому, что сильнее всего двигает итог фичи: У1–У2 высокая, У3 средняя, У4–У5 низкая"><Conf c="высокая" />уверенность</span>
        {feats.some(slipOf) && <span className="inline-flex items-center gap-1.5"><b className="font-normal text-warning-text">с дд.мм</b>деньги позже релиза Jira: по статусу эпика</span>}
      </div>
      <div className={cols}>
        <span />
        <div className="relative h-4 text-[10.5px] text-subtle-foreground">
          {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${X(t)}%` }}>{th(t)}</span>)}
        </div>
        <span />
      </div>
      {feats.map((f) => {
        const n = fval(f, h, "neg"), e = fval(f, h, "exp"), p = fval(f, h, "pos");
        const a = Math.min(n, p), b = Math.max(n, p);
        const neg = isNeg(e);
        return (
          <button key={f.key} type="button" onClick={() => onPick(f.key)} className={cn(cols, "w-full border-t border-border-seam py-1 text-left transition-colors", neg ? NEG_ROW : "hover:bg-state-hover")} title={neg ? `${NEG_TIP}. Открыть путь числа` : "Открыть путь числа"}>
            <span className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px]", neg && "pl-2")}>
              <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
              {slipOf(f) && <span className="shrink-0 text-[11px] tabular-nums text-warning-text" title={`В Jira релиз ${dmy(f.jira.planned)}. По статусу «${f.status}» деньги ждём с ${dmy(slipOf(f))}`}>с {dm(slipOf(f))}</span>}
              <Conf c={f.confidence} />
            </span>
            <span className="relative block h-6">
              <span className="absolute inset-y-0 border-l border-dashed border-foreground/30" style={{ left: `${X(0)}%` }} />
              <span className={cn("absolute top-[7px] h-2.5 rounded-full", neg ? "text-destructive-text opacity-60" : e < 0 ? "text-foreground/45" : "bg-foreground/25")}
                style={{ left: `${X(a)}%`, width: `max(${X(b) - X(a)}%, 3px)`, ...(e < 0 ? HATCH : {}) }} />
              <span className={cn("absolute top-0.5 h-5 w-1 -translate-x-1/2 rounded", neg ? "bg-destructive-text" : "bg-foreground")} style={{ left: `${X(e)}%` }} />
            </span>
            <span className="flex items-baseline gap-2 whitespace-nowrap">
              <b className="w-12 text-right text-[13.5px] tabular-nums"><Th v={e} /></b>
              <span className="text-[11px] tabular-nums text-subtle-foreground">{th(n)} … {th(p)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------- «Что решить»: действия по релизу из уже посчитанных чисел ----------
type TodoItem = { key: string; name: string; value?: ReactNode; note?: ReactNode };
function TodoGroup({ title, action, items, onPick, children }: { title: ReactNode; action: ReactNode; items: TodoItem[]; onPick: (k: string) => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const lim = 3;
  const shown = open ? items : items.slice(0, lim);
  return (
    <div className="border-t border-border-seam py-2.5 first:border-t-0 first:pt-0">
      <div className="text-[12.5px] font-medium leading-snug">{title}</div>
      <div className="text-[11.5px] leading-snug text-subtle-foreground">{action}</div>
      {items.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {shown.map((x) => (
            <button key={x.key} type="button" onClick={() => onPick(x.key)} title="Открыть путь числа"
              className="-mx-1 flex w-[calc(100%+0.5rem)] items-baseline gap-2 rounded px-1 text-left text-[12px] hover:bg-state-hover">
              <span className="min-w-0 flex-1 truncate" title={x.name}>{x.name}</span>
              {x.note && <span className="shrink-0 text-[11px] text-subtle-foreground">{x.note}</span>}
              {x.value != null && <b className="shrink-0 tabular-nums">{x.value}</b>}
            </button>
          ))}
          {items.length > lim && (
            <button type="button" onClick={() => setOpen(!open)} className="text-[11.5px] text-muted-foreground hover:text-foreground">
              {open ? "свернуть" : `ещё ${items.length - lim}`}
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function TodoBlock({ d, h, all, unest, onPick, onShowUn }: { d: Data; h: H; all: Fx[]; unest: unknown[]; onPick: (k: string) => void; onShowUn: () => void }) {
  const meta = d._meta;
  const mainOf = (f: Fx) => f.inputs.find((x: any) => x.id === f.main_input);
  const live = all.filter(nonzero);
  const minus = live.filter((f) => fval(f, h, "exp") < -0.5).sort((a, b) => fval(a, h, "exp") - fval(b, h, "exp"));
  // знак не ясен: вилка в месяц от минуса до плюса, а главный вход — бенчмарк или экспертно
  const unclear = live.filter((f) => {
    const m = mainOf(f);
    return fval(f, "month", "exp") >= -0.5 && fval(f, "month", "neg") < -0.5 && fval(f, "month", "pos") > 0.5 && (m?.level === "У4" || m?.level === "У5");
  });
  const slip = meta.pool ? all.filter((f) => slipOf(f)) : [];
  const nomeas = live.filter((f) => !f.measure);
  const drafts = live.filter((f) => f.measure?.draft);
  const sum = (xs: Fx[]) => xs.reduce((acc, f) => acc + fval(f, h, "exp"), 0);
  const rf: string | undefined = meta.release_filter;
  const days = meta.pool && rf && rf.length === 10 && meta.assessed ? Math.round((Date.parse(rf) - Date.parse(meta.assessed)) / 86_400_000) : null;
  const empty = !minus.length && !unclear.length && !slip.length && !nomeas.length && !drafts.length && !unest.length;
  return (
    <Block title="Что решить" hint={`клик по фиче — путь числа`}>
      {empty && <p className="text-[12.5px] text-subtle-foreground">По релизу решать нечего: минусов, рисков срока и пробелов нет</p>}
      {minus.length > 0 && (
        <TodoGroup title={<>Минус в ожидаемом · {minus.length} · <span className="tabular-nums"><Th v={sum(minus)} /></span></>}
          action="Запускать, смягчить или запускать тестом" onPick={onPick}
          items={minus.map((f) => ({ key: f.key, name: f.name, value: <Th v={fval(f, h, "exp")} /> }))} />
      )}
      {unclear.length > 0 && (
        <TodoGroup title={<>Знак не ясен, главное число «на глаз» · {unclear.length}</>}
          action="Может уйти в минус. Нужен тест или данные до релиза" onPick={onPick}
          items={unclear.map((f) => {
            const m = mainOf(f);
            return { key: f.key, name: f.name, note: m?.zero != null ? `в ноль при ${zeroFmt(m.zero, m.unit)}` : undefined, value: `${th(fval(f, "month", "neg"))} … ${th(fval(f, "month", "pos"))}` };
          })} />
      )}
      {slip.length > 0 && (
        <TodoGroup title={<>Статус отстаёт от релиза Jira · {slip.length}</>}
          action={<>{days != null && days >= 0 ? `До релиза ${days} дн., а по статусу деньги позже. ` : "По статусу деньги позже релиза. "}Перенести релиз в Jira или ускорить</>}
          onPick={onPick}
          items={slip.map((f) => ({ key: f.key, name: f.name, note: f.status, value: `с ${dm(slipOf(f))}` }))} />
      )}
      {nomeas.length > 0 && (
        <TodoGroup title={<>Нет метрики замера · {nomeas.length}</>}
          action="До релиза записать, какую метрику смотрим и сколько ждём" onPick={onPick}
          items={nomeas.map((f) => ({ key: f.key, name: f.name }))} />
      )}
      {drafts.length > 0 && (
        <TodoGroup title={<>Метрика замера — черновик ИИ · {drafts.length}</>}
          action="Проверить метрику и способ замера до релиза: вкладка «Замеры»" onPick={onPick}
          items={drafts.map((f) => ({ key: f.key, name: f.name }))} />
      )}
      {unest.length > 0 && (
        <TodoGroup title={<>Эпики релиза без оценки · {unest.length}</>} action="Оценить или оставить 0: в итог не входят" onPick={onPick} items={[]}>
          <button type="button" onClick={onShowUn} className="mt-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">показать список под графиком</button>
        </TodoGroup>
      )}
    </Block>
  );
}

// ---------- «К плану по строкам»: какую часть разрыва до плана месяца закрывают фичи релиза ----------
type PlanLine = { line: string; base: number | null; noise: number | null; plan: Record<string, number>; vals: Record<S, number> };
function PlanBlock({ d }: { d: Data }) {
  const rows: PlanLine[] = d._plan_lines ?? [];
  const months = [...new Set(rows.flatMap((r) => Object.keys(r.plan ?? {})))].sort();
  const relM = String(d._meta.release_filter ?? "").slice(0, 7);
  const [m, setM] = useState<string>(months.includes(relM) ? relM : months[0] ?? "");
  if (!rows.length) return null;
  const mon = (k: string) => `${MONTHS_RU[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
  const cols = "grid grid-cols-[minmax(130px,1fr)_64px_64px_112px_72px_118px_minmax(90px,130px)] whitespace-nowrap items-center gap-x-2";
  return (
    <Block className="mt-4" title="К плану по строкам финотчёта" hint="тыс. сом в месяц · база — среднее за 3 закрытых месяца · фичи — ожидаемый эффект на полном разгоне">
      {months.length > 1 && (
        <div className="mb-2"><Seg value={m} onChange={setM} options={months.map((k) => ({ v: k, label: `план: ${mon(k)}` }))} /></div>
      )}
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className={cn(cols, "border-b border-border-seam pb-1.5 text-[11px] text-subtle-foreground")}>
            <span>Строка</span><span className="text-right">База</span><span className="text-right">План {m ? MONTHS_RU[Number(m.slice(5, 7)) - 1] : ""}</span>
            <span className="text-right">Нужно прирасти</span><span className="text-right">Фичи дают</span><span className="text-right">негатив … позитив</span><span>Доля разрыва</span>
          </div>
          {rows.map((r) => {
            const plan = r.plan?.[m];
            const need = plan != null && r.base != null ? plan - r.base : null;
            const e = r.vals.exp;
            const share = need != null && need > 0 ? e / need : null;
            const small = r.noise != null && r.base != null && Math.abs(e) > 0.5 && Math.abs(e) < r.noise * r.base;
            return (
              <div key={r.line} className={cn(cols, "border-t border-border-seam py-1.5 text-[12.5px] tabular-nums first:border-t-0")}>
                <span className="min-w-0 truncate" title={r.line}>{r.line}</span>
                <span className="text-right text-muted-foreground">{r.base != null ? th(r.base, false) : "—"}</span>
                <span className="text-right text-muted-foreground">{plan != null ? th(plan, false) : "—"}</span>
                <span className="text-right">{need == null ? <span className="text-subtle-foreground">нет плана</span> : need <= 0 ? <span className="text-success">план ниже базы</span> : th(need)}</span>
                <b className="text-right" title={small ? "Меньше обычного колебания строки: без A/B не измерить" : undefined}><Th v={e} />{small ? <span className="font-normal text-subtle-foreground">*</span> : null}</b>
                <span className="text-right text-[11.5px] text-subtle-foreground">{th(r.vals.neg)} … {th(r.vals.pos)}</span>
                <span className="flex items-center gap-1.5">
                  {share != null ? (
                    <>
                      <span className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-foreground/10">
                        <span className={cn("absolute inset-y-0 left-0 rounded-full", share < 0 ? "bg-destructive-text" : "bg-foreground/60")} style={{ width: `${Math.min(100, Math.abs(share) * 100)}%` }} />
                      </span>
                      <span className={cn("text-[11.5px]", share < 0 && "text-destructive-text")}>{share < 0 ? MINUS : ""}{num(Math.abs(share) * 100, 1)}%</span>
                    </>
                  ) : <span className="text-[11.5px] text-subtle-foreground">—</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-subtle-foreground">
        Нужно прирасти = план месяца − база. Доля разрыва = эффект фич ÷ нужно прирасти. * — эффект меньше обычного колебания строки: без A/B не измерить.
        {d._plan_source ? ` ${d._plan_source}.` : ""}
      </p>
    </Block>
  );
}

function Unestimated({ items, open, onToggle }: { items: { key: string; summary: string; status: string }[]; open: boolean; onToggle: () => void }) {
  if (!items.length) return null;
  return (
    <>
      <button type="button" onClick={onToggle} className="mt-1 flex w-full items-center gap-1.5 border-t border-border-seam pt-2 text-left text-[12px] text-muted-foreground hover:text-foreground">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        {items.length} {plural(items.length, "эпик", "эпика", "эпиков")} релиза в Jira без оценки: в итог не входят
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 pl-5">
          {items.map((e) => (
            <div key={e.key} className="text-[12px]">
              <span className="font-medium">{e.summary}</span>
              <span className="ml-1.5 text-[11.5px] text-subtle-foreground">{e.key} · {e.status}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ReleaseTab({ d, h, onPick, onOpenChecks }: { d: Data; h: H; onPick: (k: string, list?: string[], label?: string) => void; onOpenChecks: () => void }) {
  const [showZero, setShowZero] = useState(false);
  const [lineF, setLineF] = useState<string | null>(null);
  const [issF, setIssF] = useState<IssId | null>(null);
  const all: Fx[] = d._explain;
  const pr = d._meta.pool ? (d._meta.pool_releases?.releases ?? []).find((r: any) => r.release === d._meta.release_filter) : null;
  const unest: { key: string; summary: string; status: string }[] = pr?.unestimated ?? [];
  const [showUn, setShowUn] = useState(all.length === 0);
  if (!all.length) {
    return (
      <Block title={`Релиз ${dmy(d._meta.release_filter)}: оценённых фич нет`} hint="числа релиза — 0">
        <Note>Чтобы оценить фичу, добавьте её в releases/features.json: релиз и статус калькулятор возьмёт из Jira сам.</Note>
        <Unestimated items={unest} open={showUn} onToggle={() => setShowUn(!showUn)} />
      </Block>
    );
  }
  const live = all.filter(nonzero).sort((a, b) => fval(b, h, "exp") - fval(a, h, "exp"));
  const zero = all.filter((f) => !nonzero(f));
  const iss: Record<string, { id: IssId; n?: number }[]> = Object.fromEntries(live.map((f) => [f.key, issuesOf(f, d, h)]));
  const has = (f: Fx, id: IssId) => iss[f.key].some((x) => x.id === id);
  const shown = live.filter((f) => (!lineF || linesOf(f).includes(lineF)) && (!issF || has(f, issF)));
  const label = [issF ? ISS[issF].chip : null, lineF].filter(Boolean).join(" · ") || "Все фичи";
  const { X, ticks } = scale(live.flatMap((f) => [fval(f, h, "neg"), fval(f, h, "pos"), fval(f, h, "exp")]));
  const minusSum = live.filter((f) => has(f, "minus")).reduce((s, f) => s + fval(f, h, "exp"), 0);
  const nChecks: number = d._meta.checks_triggered ?? 0;
  const filtered = !!(lineF || issF);
  return (
    <div className="space-y-4">
      <Hero d={d} h={h} all={all} />
      <LineCards d={d} sel={lineF} onSel={setLineF} />
      <section className="rounded-xl border border-border px-4 pb-3 pt-3.5">
        <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[14px] font-semibold">Что решить до релиза</h3>
          <span className="text-[11.5px] text-subtle-foreground">клик — оставить такие фичи</span>
          {nChecks > 0 && <button type="button" onClick={onOpenChecks} className="ml-auto text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">все проверки калькулятора: {nChecks}</button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip on={!issF} c="var(--muted-foreground)" onClick={() => setIssF(null)} label="Все фичи" count={live.length} />
          {ISS_ORDER.map((id) => {
            const n = live.filter((f) => has(f, id)).length;
            if (!n) return null;
            return <FilterChip key={id} on={issF === id} c={ISS[id].c} dot title={ISS[id].tip} onClick={() => setIssF(issF === id ? null : id)} label={ISS[id].chip} count={id === "minus" ? `${n} · ${th(minusSum)}` : n} />;
          })}
          {unest.length > 0 && <FilterChip c="var(--muted-foreground)" onClick={() => setShowUn(true)} label="Эпики без оценки" count={unest.length} title="В итог не входят: оценить или оставить 0" />}
        </div>
        <div className="mb-1.5 mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-[14px] font-semibold">Фичи</h3>
          <span className="text-[11.5px] text-subtle-foreground">{filtered ? `фильтр: ${label} · ${shown.length} из ${live.length}` : `${live.length} с числом`} · тыс. сом {hLabel(h, d)} · клик — карточка фичи</span>
          {filtered && <button type="button" onClick={() => { setLineF(null); setIssF(null); }} className="text-[12px] text-muted-foreground hover:text-foreground">сбросить фильтр ×</button>}
        </div>
        <div className={cn(ROWC, "pb-1 pl-4 pr-1 text-[10.5px] text-subtle-foreground")}>
          <span>фича · полоса — строка финотчёта</span>
          <span className="hidden @5xl:block">деньги с</span>
          <span className="hidden @5xl:block">уверенность</span>
          <span className="relative block h-4">{ticks.map((t) => <span key={t} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${X(t)}%` }}>{th(t)}</span>)}</span>
          <span className="text-right">ожид.</span>
          <span className="hidden @5xl:block">вилка</span>
          <span>что решить</span>
          <span className="text-right">ICE</span>
        </div>
        {shown.map((f) => <FxRow key={f.key} f={f} d={d} h={h} X={X} iss={iss[f.key]} onClick={() => onPick(f.key, shown.map((x) => x.key), label)} />)}
        {!shown.length && <p className="border-t border-border-seam py-3 text-[12.5px] text-subtle-foreground">Таких фич нет</p>}
        {zero.length > 0 && !filtered && (
          <button type="button" onClick={() => setShowZero(!showZero)} className="mt-1 flex w-full items-center gap-1.5 border-t border-border-seam pt-2 text-left text-[12px] text-muted-foreground hover:text-foreground">
            <Icon name={showZero ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
            {zero.length} фич с нулём: путь до денег не подтверждён данными
          </button>
        )}
        {showZero && !filtered && (
          <div className="mt-1 space-y-1 pl-5">
            {zero.map((f) => (
              <button key={f.key} type="button" onClick={() => onPick(f.key, zero.map((x) => x.key), "Фичи с нулём")} className="block w-full rounded text-left text-[12px] hover:bg-state-hover">
                <span className="font-medium">{f.name}</span>
                {f.main_assumption && <div className="text-[11.5px] text-subtle-foreground">{f.main_assumption}</div>}
              </button>
            ))}
          </div>
        )}
        <Unestimated items={unest} open={showUn} onToggle={() => setShowUn(!showUn)} />
      </section>
    </div>
  );
}
function Chain({ items }: { items: ({ label: string; value: ReactNode; off?: boolean; dark?: boolean } | { arrow: string })[] }) {
  return (
    <div>
      {items.map((it, i) => "arrow" in it ? (
        it.arrow.length === 1 ? (
          <div key={i} className="px-2.5 py-0.5 text-[13px] leading-none text-subtle-foreground">{it.arrow}</div>
        ) : (
          <div key={i} className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-subtle-foreground"><Icon name="ChevronDown" className="size-3.5 shrink-0" />{it.arrow}</div>
        )
      ) : (
        <div key={i} className={cn("flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[12.5px]", it.off ? "border-dashed border-border text-subtle-foreground" : it.dark ? "border-foreground bg-foreground text-background" : "border-border bg-surface-recessed")}>
          <span>{it.label}</span><b className="tabular-nums">{it.value}</b>
        </div>
      ))}
    </div>
  );
}

// ---------- Экран 2. Путь числа ----------
// Рассказ сверху вниз: коротко → из чего → как посчитана часть → от чего зависит → когда деньги → как проверим.
const LEVEL_RU: Record<string, string> = { У1: "факт", У2: "свой аналог", У3: "своя воронка", У4: "бенчмарк", У5: "экспертно" };
const COST_MECH = ["цена", "бонусы и скидки"];

function compVal(c: any, h: H, s: S): number {
  return h === "month" ? c.month[s] : c[h][s];
}
/** сом целиком, со знаком: для сверки умножения */
function som(v: number) {
  const n = Math.round(v);
  return n === 0 ? "0" : (n < 0 ? MINUS : "+") + grp(n);
}
function parts(n: number) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "часть" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "части" : "частей";
}
function LvlWord({ level }: { level: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title="Уровень доказательства: У1 факт, У2 свой аналог, У3 своя воронка, У4 бенчмарк, У5 экспертно">
      <Lvl level={level} />
      <span className="text-[11px] text-muted-foreground">{LEVEL_RU[level] ?? "уровень не указан"}</span>
    </span>
  );
}

// Формула компонента из конфига → дерево, чтобы подставить числа и показать умножение.
type Ast = { t: "num"; v: number } | { t: "id"; id: string } | { t: "neg"; a: Ast } | { t: "bin"; op: string; a: Ast; b: Ast };
function parseFormula(src: string): Ast | null {
  const s = String(src ?? "");
  const toks = s.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|\*\*|[-+*/()]/g);
  if (!toks || toks.join("") !== s.replace(/\s+/g, "")) return null;
  let i = 0;
  const expr = (): Ast => { let a = term(); while (toks[i] === "+" || toks[i] === "-") { const op = toks[i++]; a = { t: "bin", op, a, b: term() }; } return a; };
  const term = (): Ast => { let a = unary(); while (toks[i] === "*" || toks[i] === "/") { const op = toks[i++]; a = { t: "bin", op, a, b: unary() }; } return a; };
  const unary = (): Ast => { if (toks[i] === "-") { i++; return { t: "neg", a: unary() }; } if (toks[i] === "+") { i++; return unary(); } return atom(); };
  const atom = (): Ast => {
    const k = toks[i++];
    if (k === "(") { const a = expr(); if (toks[i++] !== ")") throw new Error("скобка"); return a; }
    if (k && /^\d/.test(k)) return { t: "num", v: Number(k) };
    if (k && /^[A-Za-z_]/.test(k)) return { t: "id", id: k };
    throw new Error("знак");
  };
  try { const a = expr(); return i === toks.length ? a : null; } catch { return null; }
}
function evalAst(a: Ast, env: Record<string, number>): number {
  if (a.t === "num") return a.v;
  if (a.t === "id") return env[a.id] ?? NaN;
  if (a.t === "neg") return -evalAst(a.a, env);
  const x = evalAst(a.a, env), y = evalAst(a.b, env);
  return a.op === "+" ? x + y : a.op === "-" ? x - y : a.op === "*" ? x * y : x / y;
}
const OP: Record<string, string> = { "+": "+", "-": MINUS, "*": "×", "/": "÷" };
function showAst(a: Ast, leaf: (x: Ast) => string, ctx = 0, strictRight = false): string {
  if (a.t === "num" || a.t === "id") { const s = leaf(a); return s.startsWith(MINUS) && ctx > 0 ? `(${s})` : s; }
  const p = a.t === "neg" ? 3 : a.op === "+" || a.op === "-" ? 1 : 2;
  const s = a.t === "neg" ? MINUS + showAst(a.a, leaf, 3) : `${showAst(a.a, leaf, p)} ${OP[a.op]} ${showAst(a.b, leaf, p, a.op === "-" || a.op === "/")}`;
  return p < ctx || (strictRight && p === ctx) ? `(${s})` : s;
}
const constText = (v: number) => (v > 0 && v < 1 ? pct(v) : fv(v, ""));
/** множители верхнего уровня (−a × b ÷ c); null, если сверху сумма */
function productOf(root: Ast): { neg: boolean; items: { op: string; node: Ast }[] } | null {
  let a = root, neg = false;
  while (a.t === "neg") { neg = !neg; a = a.a; }
  if (a.t === "bin" && (a.op === "+" || a.op === "-")) return null;
  const items: { op: string; node: Ast }[] = [];
  const walk = (x: Ast, op: string) => {
    if (x.t === "bin" && (x.op === "*" || x.op === "/")) { walk(x.a, op); items.push({ op: x.op, node: x.b }); }
    else items.push({ op, node: x });
  };
  walk(a, "*");
  for (const it of items) while (it.node.t === "neg") { neg = !neg; it.node = it.node.a; }
  return { neg, items };
}

function Op({ children }: { children: ReactNode }) {
  return <span className="self-center px-0.5 text-[22px] font-light leading-none text-subtle-foreground">{children}</span>;
}
// ---------- правка входа в карточке (вариант 1, решение PO 18.11.2026) ----------
type Edit = { value: number; base: number; moved: boolean; set: (v: number) => void; reset: () => void };
/** число для поля ввода: доля — в процентах, без знака % */
function toShow(v: number, unit: string) {
  if (!Number.isFinite(v)) return "";
  if (unit === "доля") return num(v * 100, 2);
  return Math.abs(v) >= 1000 ? (v < 0 ? MINUS : "") + grp(v) : num(v);
}
function fromShow(s: string, unit: string): number | null {
  const t = s.replace(/[\s  %]/g, "").replace(",", ".").replace(MINUS, "-");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return unit === "доля" ? n / 100 : n;
}
/** ±10% от самого числа: «+» всегда сдвигает число вправо по оси */
function stepBy(v: number, dir: 1 | -1, unit: string) {
  const step = v !== 0 ? Math.abs(v) * 0.1 : unit === "доля" ? 0.01 : 1;
  const n = v + dir * step;
  return Math.abs(n) >= 100 ? Math.round(n) : Number(n.toPrecision(4));
}
function NumField({ value, unit, label, onCommit, compact }: { value: number; unit: string; label: string; onCommit: (v: number) => void; compact?: boolean }) {
  const [text, setText] = useState(() => toShow(value, unit));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(toShow(value, unit)); }, [value, unit]);
  const bad = fromShow(text, unit) == null;
  return (
    <input type="text" inputMode="decimal" value={text} aria-label={label} title="Введите число и нажмите Enter или перейдите дальше"
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onBlur={() => { focused.current = false; setText(toShow(value, unit)); }}
      onChange={(e) => { setText(e.target.value); const n = fromShow(e.target.value, unit); if (n != null) onCommit(n); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setText(toShow(value, unit)); e.currentTarget.blur(); }
      }}
      className={cn("w-full min-w-0 rounded-md border bg-transparent px-2 tabular-nums outline-none focus:border-foreground/60", compact ? "py-0 text-[13px] font-semibold" : "py-0.5 text-xl font-semibold", bad ? "border-current text-destructive-text" : "border-border")} />
  );
}
function StepBtn({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground">
      {children}
    </button>
  );
}
/** правка числа в строку — вкладка «Что если»: поле, ±10%, вернуть из конфига */
function InlineEdit({ inp, value, base, set }: { inp: any; value: number; base: number; set: (v: number | null) => void }) {
  const moved = Math.abs(value - base) > 1e-12;
  const u = inp.unit === "доля" ? "%" : unitOf(inp.unit);
  const put = (v: number) => set(Math.abs(v - base) < 1e-12 ? null : v);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <div className="w-[96px]"><NumField compact value={value} unit={inp.unit} label={inp.name} onCommit={put} /></div>
      {u && <span className="text-[11px] text-subtle-foreground">{u}</span>}
      <StepBtn onClick={() => put(stepBy(value, -1, inp.unit))} title="Уменьшить число на 10%">{MINUS}10%</StepBtn>
      <StepBtn onClick={() => put(stepBy(value, 1, inp.unit))} title="Увеличить число на 10%">+10%</StepBtn>
      {moved && <StepBtn onClick={() => set(null)} title={`Вернуть число из конфига: ${fv(base, inp.unit)}`}><Icon name="RotateCcw" className="size-3" /></StepBtn>}
    </div>
  );
}
function FactorCard({ inp, edit, main }: { inp: any; edit?: Edit; main?: boolean }) {
  const [open, setOpen] = useState(false);
  const v = inp.values;
  const moved = !!edit?.moved;
  const u = inp.unit === "доля" ? "%" : unitOf(inp.unit);
  return (
    <div className={cn("relative flex w-[196px] shrink-0 flex-col rounded-lg border p-3", moved ? "border-2 border-foreground bg-state-active" : main ? "border-2" : inp.varied ? "border-2 border-foreground" : "border-border bg-surface-recessed")}
      style={main && !moved ? { borderColor: C_ATT, boxShadow: `0 0 14px ${tint(C_ATT, 30)}`, background: tint(C_ATT, 6) } : undefined}>
      {moved ? <span className="absolute -top-2.5 left-2.5 rounded-full bg-foreground px-2 text-[10px] leading-5 text-background">изменено</span>
        : inp.varied && <span className="absolute -top-2.5 left-2.5 rounded-full bg-foreground px-2 text-[10px] leading-5 text-background">не знаем точно: вилка</span>}
      <div className="line-clamp-2 min-h-[30px] text-[11.5px] leading-snug text-muted-foreground" title={inp.name}>{main && <MainStar />}{inp.name}</div>
      {edit ? (
        <>
          <div className="mt-1 flex items-center gap-1.5">
            <NumField value={edit.value} unit={inp.unit} label={inp.name} onCommit={edit.set} />
            {u && <span className="shrink-0 text-[11px] text-subtle-foreground">{u}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <StepBtn onClick={() => edit.set(stepBy(edit.value, -1, inp.unit))} title="Уменьшить число на 10%">{MINUS}10%</StepBtn>
            <StepBtn onClick={() => edit.set(stepBy(edit.value, 1, inp.unit))} title="Увеличить число на 10%">+10%</StepBtn>
            {moved && <StepBtn onClick={edit.reset} title="Вернуть число из конфига"><Icon name="RotateCcw" className="size-3" /></StepBtn>}
          </div>
          {moved && <div className="mt-1 text-[11px] tabular-nums text-subtle-foreground">в конфиге <s>{fv(edit.base, inp.unit)}</s>{unitOf(inp.unit) ? ` ${unitOf(inp.unit)}` : ""}</div>}
        </>
      ) : (
        <div className="mt-0.5 text-xl font-semibold tabular-nums">
          {fv(v.exp, inp.unit)} <span className="text-[11px] font-normal text-subtle-foreground">{unitOf(inp.unit)}</span>
        </div>
      )}
      {inp.varied && <div className="mt-1.5"><Triple neg={fv(v.neg, inp.unit)} exp={fv(v.exp, inp.unit)} pos={fv(v.pos, inp.unit)} /></div>}
      <div className="mt-2"><LvlWord level={inp.level} /></div>
      <button type="button" onClick={() => setOpen(!open)} className={cn("mt-1 text-left text-[11px] leading-snug text-subtle-foreground hover:text-muted-foreground", !open && "line-clamp-2")} title={open ? "Свернуть" : "Откуда число — полностью"}>
        {inp.source || "источник не указан"}
        {inp.analog != null && <> · аналог: {fv(inp.analog, inp.unit)}</>}
        {inp.deviation && <> · отступление: {inp.deviation}</>}
      </button>
    </div>
  );
}
function SmallFactor({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <div className="flex min-w-[92px] max-w-[190px] shrink-0 flex-col justify-center rounded-lg border border-dashed border-border px-3 py-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-subtle-foreground">{label}</div>
    </div>
  );
}

function PartsBars({ comps, h, total, sel, onSel }: { comps: any[]; h: H; total: number; sel: number; onSel: (i: number) => void }) {
  const vals = comps.map((c) => compVal(c, h, "exp"));
  let lo = Math.min(0, total, ...vals), hi = Math.max(0, total, ...vals);
  if (hi - lo < 1) hi = lo + 1;
  const pad = (hi - lo) * 0.03;
  lo -= pad; hi += pad;
  const X = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const cols = "grid grid-cols-[minmax(150px,340px)_minmax(0,1fr)_64px] items-center gap-x-3";
  // цвет части — строка финотчёта, минус — красная штриховка, итог — плюс зелёный, минус красный
  const bar = (v: number, kind: "part" | "total", line?: string) => {
    const c = kind === "total" ? (v < -0.5 ? C_NEG : C_POS) : lineColor(line);
    const fill: CSSProperties = v < -0.5
      ? { backgroundImage: `repeating-linear-gradient(135deg, ${C_NEG} 0 3px, ${tint(C_NEG, kind === "total" ? 55 : 30)} 3px 6px)` }
      : { background: kind === "total" ? `linear-gradient(90deg, ${tint(c, 45)}, ${c})` : c, boxShadow: `0 0 6px ${tint(c, 60)}` };
    return (
      <span className="relative block h-5">
        <span className="absolute -inset-y-1.5 border-l border-dashed border-foreground/35" style={{ left: `${X(0)}%` }} />
        <span className="absolute top-1 h-3 rounded-sm"
          style={{ left: `${X(Math.min(0, v))}%`, width: `max(${X(Math.max(0, v)) - X(Math.min(0, v))}%, 2px)`, ...fill }} />
      </span>
    );
  };
  return (
    <div>
      {comps.map((c, i) => {
        const once = c.window_days && h === "month";
        return (
          <button key={i} type="button" onClick={() => onSel(i)} title="Показать, как посчитана эта часть"
            className={cn(cols, "w-full rounded-md px-2 py-1 text-left transition-colors", i === sel ? "bg-state-active" : "hover:bg-state-hover")}>
            <span className="flex min-w-0 items-center gap-1 text-[12.5px]">
              <Icon name="ChevronRight" className={cn("size-3.5 shrink-0", i === sel ? "text-foreground" : "text-transparent")} />
              <span className={cn("min-w-0 truncate", i === sel && "font-semibold")} title={c.name}>{c.name}</span>
              {once && <Chip dashed>разово</Chip>}
            </span>
            {bar(vals[i], "part", c.line)}
            <b className="text-right text-[13px] tabular-nums">{once ? "—" : <Th v={vals[i]} />}</b>
          </button>
        );
      })}
      <div className={cn(cols, "mt-1 border-t border-border px-2 pt-2")}>
        <span className="flex items-center gap-1 text-[12.5px] font-semibold"><span className="w-3.5 text-center">=</span>Итог фичи</span>
        {bar(total, "total")}
        <b className="text-right text-[14px] tabular-nums"><Th v={total} /></b>
      </div>
    </div>
  );
}

// Шаги расчёта: из конфига (поле steps, названия задаёт автор) или автоматически — для формул сложнее умножения.
type UStep = { id: string; name: string; ast: Ast; value: number; unit: string; group?: string };
function stepFmt(v: number | null | undefined, unit: string) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "доля") return num(v * 100, 1) + "%";
  // штуки и люди — до 1–2 знаков, иначе «13,025 шт.» читается как тысячи; отношения — до 3 знаков
  const n = Math.abs(v) >= 1000 ? (v < 0 ? MINUS : "") + grp(v) : num(v, unit ? (Math.abs(v) >= 10 ? 1 : 2) : 3);
  return unit ? `${n} ${unit}` : n;
}
function explicitSteps(comp: any, raw: number): UStep[] | null {
  if (!Array.isArray(comp.steps) || !comp.steps.length) return null;
  const out: UStep[] = [];
  for (const st of comp.steps) {
    const ast = parseFormula(st.formula);
    const value = st.values?.exp;
    if (!ast || value == null || !Number.isFinite(value)) return null;
    out.push({ id: st.id, name: st.name, ast, value, unit: st.unit ?? "", group: st.group ?? undefined });
  }
  const last = out[out.length - 1].value;
  return Math.abs(last - raw) <= Math.max(1, Math.abs(raw) * 0.005) ? out : null;
}
function autoSteps(root: Ast, env: Record<string, number>): UStep[] {
  const steps: UStep[] = [];
  let gi = 0;
  const isSum = (x: Ast) => x.t === "bin" && (x.op === "+" || x.op === "-");
  const add = (ast: Ast, name: string, unit: string): Ast => {
    const id = `_s${steps.length + 1}`;
    const value = evalAst(ast, { ...env, ...Object.fromEntries(steps.map((s) => [s.id, s.value])) });
    steps.push({ id, name, ast, value, unit });
    return { t: "id", id };
  };
  // скобки с суммой внутри умножения и деления — отдельные шаги, изнутри наружу
  const lift = (x: Ast): Ast => {
    if (x.t === "neg") return { t: "neg", a: lift(x.a) };
    if (x.t !== "bin") return x;
    let a = lift(x.a), b = lift(x.b);
    if (x.op === "*" || x.op === "/") {
      if (isSum(a)) a = add(a, `Скобка ${++gi}`, "");
      if (isSum(b)) b = add(b, `Скобка ${++gi}`, "");
    }
    return { t: "bin", op: x.op, a, b };
  };
  const top = lift(root);
  const terms: { sign: string; node: Ast }[] = [];
  const split = (x: Ast, sign: string) => {
    if (x.t === "bin" && (x.op === "+" || x.op === "-")) { split(x.a, sign); split(x.b, x.op === "-" ? (sign === "+" ? "-" : "+") : sign); }
    else terms.push({ sign, node: x });
  };
  split(top, "+");
  if (terms.length > 1) {
    const refs = terms.map((t, i) => ({ sign: t.sign, node: t.node.t === "bin" || t.node.t === "neg" ? add(t.node, `Слагаемое ${i + 1}`, "сом") : t.node }));
    let acc: Ast = refs[0].sign === "-" ? { t: "neg", a: refs[0].node } : refs[0].node;
    for (const r of refs.slice(1)) acc = { t: "bin", op: r.sign, a: acc, b: r.node };
    add(acc, "Итог формулы", "сом");
  } else add(top, "Итог формулы", "сом");
  return steps;
}
function StepsBox({ steps, leaf, words, auto, broken }: { steps: UStep[]; leaf: (x: Ast) => string; words: string; auto: boolean; broken: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-3 py-2.5">
      <div className="mb-1 text-[11.5px] text-muted-foreground">Формула: {words}</div>
      <ol>
        {steps.map((st, i) => {
          const last = i === steps.length - 1;
          const head = st.group && st.group !== steps[i - 1]?.group;
          return (
            <Fragment key={st.id}>
            {head && <li className="pb-0.5 pt-2.5 text-[12px] font-semibold first:pt-0.5">{st.group}</li>}
            <li className={cn("grid grid-cols-[22px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 border-t border-border-seam py-1.5 text-[12.5px] first:border-t-0 @3xl:grid-cols-[22px_minmax(180px,320px)_minmax(0,1fr)_auto]", last && "border-t-border")}>
              <span className="tabular-nums text-subtle-foreground">{i + 1}</span>
              <span className={cn(last && "font-semibold")}>{st.name}</span>
              <span className="col-start-2 tabular-nums text-muted-foreground @3xl:col-start-auto">{showAst(st.ast, leaf)}</span>
              <b className={cn("col-start-2 whitespace-nowrap tabular-nums @3xl:col-start-auto @3xl:text-right", !last && "font-semibold")}>= {stepFmt(st.value, st.unit)}</b>
            </li>
            </Fragment>
          );
        })}
      </ol>
      {broken && <p className="mt-1.5 text-[11px] text-destructive-text">Шаги из конфига не сходятся с формулой — показаны шаги, собранные автоматически.</p>}
      {auto && !broken && <p className="mt-1.5 text-[11px] text-subtle-foreground">Шаги собраны автоматически. Названия шагов можно задать в конфиге: поле steps у компонента.</p>}
    </div>
  );
}

function CompCalc({ comp, fx, h, d, byId, ed }: { comp: any; fx: Fx; h: H; d: Data; byId: Record<string, any>; ed?: (id: string) => Edit | undefined }) {
  const ast = parseFormula(comp.formula);
  const env: Record<string, number> = Object.fromEntries(fx.inputs.map((x: any) => [x.id, x.values.exp]));
  const raw = ast ? evalAst(ast, env) : NaN;
  const mv = comp.month_raw?.exp ?? comp.month.exp;
  // показываем подстановку, только если она даёт то же число, что калькулятор
  const ok = ast != null && Number.isFinite(raw) && Math.abs(raw * comp.plateau - mv) <= Math.max(1, Math.abs(mv) * 0.005);
  const given = ok ? explicitSteps(comp, raw) : null;
  const prod = ok && !given ? productOf(ast!) : null;
  const steps = given ?? (ok && !prod ? autoSteps(ast!, env) : null);
  const broken = !given && Array.isArray(comp.steps) && comp.steps.length > 0;
  const once = !!comp.window_days;
  const months = h === "month" ? null : comp.months.exp[h];
  const result = h === "month" ? mv : compVal(comp, h, "exp");
  const valueLeaf = (x: Ast) => (x.t === "num" ? constText(x.v) : x.t === "id" ? fv(byId[x.id]?.values.exp, byId[x.id]?.unit ?? "") : "");
  const nameLeaf = (x: Ast) => { if (x.t === "num") return constText(x.v); const n = x.t === "id" ? String(byId[x.id]?.name ?? x.id) : ""; return n.charAt(0).toLowerCase() + n.slice(1); };
  const stepVal: Record<string, UStep> = Object.fromEntries((steps ?? []).map((s) => [s.id, s]));
  const stepLeaf = (x: Ast) => {
    if (x.t === "num") return x.v > 0 && x.v < 1 ? pct(x.v) : fv(x.v, "");
    if (x.t !== "id") return "";
    if (stepVal[x.id]) return stepFmt(stepVal[x.id].value, stepVal[x.id].unit);
    const inp = byId[x.id];
    if (!inp) return x.id;
    const u = unitOf(inp.unit);
    return fv(inp.values.exp, inp.unit) + (u ? ` ${u}` : "");
  };
  const factor = (node: Ast, key: number) => {
    if (node.t === "id" && byId[node.id]) return <FactorCard key={key} inp={byId[node.id]} edit={ed?.(node.id)} main={fx.main_input === node.id} />;
    if (node.t === "num") return <SmallFactor key={key} value={constText(node.v)} label="число из формулы" />;
    const v = evalAst(node, env);
    return <SmallFactor key={key} value={v > 0 && v < 1 ? pct(v) : fv(v, "")} label={<>{showAst(node, valueLeaf)}<br />{showAst(node, nameLeaf)}</>} />;
  };
  const chain: ReactNode[] = [];
  if (prod) {
    if (prod.neg) chain.push(<Op key="neg">{MINUS}</Op>);
    prod.items.forEach((it, i) => {
      if (i > 0) chain.push(<Op key={`op${i}`}>{it.op === "/" ? "÷" : "×"}</Op>);
      chain.push(factor(it.node, i));
    });
  } else if (steps) {
    if (comp.plateau !== 1 || months != null) chain.push(<SmallFactor key="st" value={stepFmt(steps[steps.length - 1].value, "сом")} label={`итог шагов, шаг ${steps.length}`} />);
  } else {
    chain.push(
      <div key="expr" className="min-w-[260px] flex-1 rounded-lg border border-border bg-surface-recessed px-3 py-2.5">
        <div className="text-[11.5px] text-muted-foreground">Формула: {comp.formula_text}</div>
        <div className="mt-1.5 text-[12px] text-subtle-foreground">Подставить числа не получилось: формулу не удалось разобрать. Результат — справа.</div>
      </div>,
    );
  }
  if (comp.plateau !== 1) chain.push(...(chain.length ? [<Op key="pl">×</Op>] : []), <SmallFactor key="plv" value={pct(comp.plateau)} label="на пике разгона: столько эффекта набирается" />);
  if (months != null) chain.push(<Op key="mo">×</Op>, <SmallFactor key="mov" value={num(months, 2)} label={`месяца эффекта в ${h === "cy" ? d._meta.cy : d._meta.ny}, с разгоном`} />);
  return (
    <div>
      {steps && <StepsBox steps={steps} leaf={stepLeaf} words={comp.formula_text} auto={!given} broken={broken} />}
      <div className="flex flex-wrap items-stretch gap-x-2 gap-y-4 pt-2">
        {chain}
        {chain.length > 0 && <Op>=</Op>}
        <div className="flex w-[200px] shrink-0 flex-col justify-center rounded-lg bg-foreground p-3 text-background">
          <div className="text-[11.5px] opacity-75">{h === "month" ? (once ? `в месяц, ${comp.window_days} дн. разово` : "в месяц") : `за ${h === "cy" ? d._meta.cy : d._meta.ny}`}</div>
          <div className="text-2xl font-semibold tabular-nums">{th(result)} <span className="text-[11px] font-normal opacity-75">тыс. сом</span></div>
          <div className="text-[11px] tabular-nums opacity-75">{som(result)} сом</div>
          {!once || h !== "month" ? (
            <div className="mt-2"><Triple inverse neg={th(compVal(comp, h, "neg"))} exp={th(compVal(comp, h, "exp"))} pos={th(compVal(comp, h, "pos"))} /></div>
          ) : <div className="mt-2 text-[11px] opacity-75">В «в месяц» не входит: разовый эффект считается только в годах</div>}
        </div>
      </div>
      {!prod && comp.inputs.length > 0 && (
        <div className="mt-4">
          <div className="mb-3 text-[12px] font-medium text-muted-foreground">Входы формулы</div>
          <div className="flex flex-wrap gap-3 pt-1">{comp.inputs.map((id: string) => byId[id] && <FactorCard key={id} inp={byId[id]} edit={ed?.(id)} main={fx.main_input === id} />)}</div>
        </div>
      )}
      <p className="mt-3 text-[11.5px] leading-snug text-subtle-foreground">
        Строка финотчёта: {comp.line || "—"} · деньги: {MONEY_RU[comp.money] ?? comp.money}
        {comp.mechanic ? ` · механика: ${comp.mechanic}` : ""}
        {comp.group ? ` · группа пересечений: ${comp.group}` : ""}
        {comp.deviation ? ` · отступление: ${comp.deviation}` : ""}
      </p>
    </div>
  );
}

function RampCurve({ ramp }: { ramp: Record<string, number> }) {
  const pts = Object.entries(ramp).map(([dd, v]) => [Number(dd), v] as const).sort((a, b) => a[0] - b[0]);
  const maxD = Math.max(45, ...pts.map((p) => p[0]));
  const W = 250, HG = 118;
  const x = (dd: number) => 16 + (dd / maxD) * (W - 32);
  const y = (v: number) => 104 - v * 84;
  const line = pts.length === 1 ? `${x(0)},${y(pts[0][1])} ${x(maxD)},${y(pts[0][1])}` : [...pts, [maxD, pts[pts.length - 1][1]] as const].map(([dd, v]) => `${x(dd).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={HG + 12} className="shrink-0 text-foreground">
      <line x1={8} y1={y(1)} x2={W - 8} y2={y(1)} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="3 3" />
      <text x={16} y={y(1) - 4} fontSize={10} fill="currentColor" fillOpacity={0.5}>полный эффект</text>
      <line x1={8} y1={106} x2={W - 8} y2={106} stroke="currentColor" strokeOpacity={0.3} />
      <polyline points={line} fill="none" stroke="currentColor" strokeOpacity={0.6} strokeWidth={2} />
      {pts.map(([dd, v], i) => (
        <g key={dd}>
          <circle cx={x(dd)} cy={y(v)} r={3} fill="currentColor" />
          {(i === 0 || i === pts.length - 1 || pts.length <= 4) && <text x={x(dd) + (i === 0 ? 10 : 0)} y={v < 0.35 ? y(v) - 8 : y(v) + 16} textAnchor="middle" fontSize={10.5} fill="currentColor" fillOpacity={0.7}>{Math.round(v * 100)}%</text>}
        </g>
      ))}
      <text x={16} y={122} fontSize={10.5} fill="currentColor" fillOpacity={0.55}>день 1</text>
      <text x={W - 16} y={122} fontSize={10.5} fill="currentColor" fillOpacity={0.55} textAnchor="end">день {maxD + 1}</text>
    </svg>
  );
}

type FxLever = { inp: any; a: number; b: number; w: number };
/** значение входа, при котором фича выходит в ноль (из build.py) */
function zeroFmt(v: number, unit: string) {
  if (unit === "доля") { const p = v * 100; return num(p, Math.abs(p) > 0 && Math.abs(p) < 1 ? 2 : 1) + "%"; }
  return Math.abs(v) >= 1000 ? fv(v, unit) : num(v, 2);
}
function zeroInside(inp: any) {
  const v = inp.values, lo = Math.min(v.neg, v.pos), hi = Math.max(v.neg, v.pos), eps = (hi - lo) * 1e-4 + 1e-12;
  return inp.zero != null && inp.zero > lo + eps && inp.zero < hi - eps;
}
function zeroAtEdge(inp: any) {
  const v = inp.values, eps = Math.abs(v.pos - v.neg) * 1e-4 + 1e-12;
  return inp.zero != null && (Math.abs(inp.zero - v.neg) <= eps || Math.abs(inp.zero - v.pos) <= eps);
}
function ZeroNote({ inp }: { inp: any }) {
  if (inp.zero === undefined) return null;
  if (inp.zero === null) return <span className="text-subtle-foreground" title="Даже на краю разумных значений этого входа фича не меняет знак">в ноль не выходит</span>;
  const u = unitOf(inp.unit);
  return (
    <span className={zeroInside(inp) ? "text-destructive-text" : "text-subtle-foreground"} title="Остальные входы — ожидаемые">
      в ноль при {zeroFmt(inp.zero, inp.unit)}{u ? ` ${u}` : ""}{zeroInside(inp) ? " — внутри вилки" : zeroAtEdge(inp) ? ` — это ${Math.abs(inp.zero - inp.values.neg) <= Math.abs(inp.zero - inp.values.pos) ? "негатив" : "позитив"}` : ""}
    </span>
  );
}
function Tornado({ levers, total, main }: { levers: FxLever[]; total: number; main?: string | null }) {
  const maxL = Math.max(1, ...levers.map((l) => Math.max(Math.abs(l.a), Math.abs(l.b))));
  const showZero = Math.abs(total) > 0.5 && Math.abs(total) <= maxL * 3;
  const L = showZero ? Math.max(maxL, Math.abs(total) * 1.04) : maxL;
  const X = (v: number) => 50 + (v / L) * 38;
  const Z = X(-total);
  const cols = "grid grid-cols-1 items-center gap-x-3 gap-y-1 @3xl:grid-cols-[minmax(180px,300px)_170px_minmax(0,1fr)]";
  const zeroLine = showZero && <span className="absolute -inset-y-2 border-l-2 border-dashed" style={{ left: `${Z}%`, borderColor: C_ATT }} />;
  return (
    <div>
      <div className={cn(cols, "hidden border-b border-border-seam pb-1.5 text-[11px] text-subtle-foreground @3xl:grid")}>
        <span>Вход с вилкой</span><span>негатив · ожидаем · позитив</span>
        <span className="relative block h-4">
          <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">сдвиг итога фичи, тыс. сом в месяц</span>
        </span>
      </div>
      {showZero && (
        <div className={cn(cols, "hidden pt-1 @3xl:grid")}>
          <span /><span />
          <span className="relative block h-4 text-[11px] font-medium" style={{ color: C_ATT }}>
            <span className={cn("absolute whitespace-nowrap", Z > 70 ? "-translate-x-full pr-1.5" : "pl-1.5")} style={{ left: `${Z}%` }}>фича = 0</span>
          </span>
        </div>
      )}
      {levers.map((l) => {
        const v = l.inp.values;
        return (
          <div key={l.inp.id} className={cn(cols, "border-t border-border-seam py-2 first:border-t-0")}>
            <div className="min-w-0">
              <div className="text-[12.5px] leading-snug">{l.inp.id === main && <MainStar />}{l.inp.name}</div>
              <div className="mt-0.5"><LvlWord level={l.inp.level} /></div>
            </div>
            <div className="text-[12px] tabular-nums text-muted-foreground">
              <div>{fv(v.neg, l.inp.unit)} · <b className="text-foreground">{fv(v.exp, l.inp.unit)}</b> · {fv(v.pos, l.inp.unit)}</div>
              <div className="mt-0.5 text-[11.5px]"><ZeroNote inp={l.inp} /></div>
            </div>
            <div className="relative h-7">
              <span className="absolute inset-y-0 border-l border-foreground/50" style={{ left: `${X(0)}%` }} />
              {zeroLine}
              {l.a < 0 && <span className="absolute top-2 h-3 rounded-l-sm" style={{ left: `${X(l.a)}%`, width: `${X(0) - X(l.a)}%`, background: `linear-gradient(270deg, ${tint(C_NEG, 30)}, ${C_NEG})` }} />}
              {l.b > 0 && <span className="absolute top-2 h-3 rounded-r-sm" style={{ left: `${X(0)}%`, width: `${X(l.b) - X(0)}%`, background: `linear-gradient(90deg, ${tint(C_POS, 30)}, ${C_POS})` }} />}
              <span className="absolute top-[7px] -translate-x-full pr-1.5 text-[11.5px] font-semibold tabular-nums" style={{ left: `${X(Math.min(0, l.a))}%`, color: l.a < -0.5 ? C_NEG : undefined }}>{th(l.a)}</span>
              <span className="absolute top-[7px] pl-1.5 text-[11.5px] font-semibold tabular-nums" style={{ left: `${X(Math.max(0, l.b))}%`, color: l.b > 0.5 ? C_POS : undefined }}>{th(l.b)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SumRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-border-seam py-2 text-[13px] leading-snug first:border-t-0 first:pt-0">
      <span className="text-[12px] text-subtle-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

type WiState = { data: Data | null; busy: boolean; ms: number | null; error: string | null };
function PathTab({ d, base, h, sel, onSel, ov, setInput, onReset, wi, single }: {
  d: Data; base: Data; h: H; sel: string | null; onSel: (k: string) => void;
  ov: Inputs; setInput: (key: string, id: string, v: number | null) => void; onReset: () => void; wi: WiState; single?: boolean;
}) {
  const all: Fx[] = d._explain;
  // порядок и деление «с нулём / без» — по конфигу, чтобы фича не прыгала по списку во время правки
  const baseOf: Record<string, Fx> = Object.fromEntries((base._explain as Fx[]).map((f) => [f.key, f]));
  const bf = (f: Fx) => baseOf[f.key] ?? f;
  const feats = all.filter((f) => nonzero(bf(f))).sort((a, b) => fval(bf(b), h, "exp") - fval(bf(a), h, "exp"));
  const zero = all.filter((f) => !nonzero(bf(f)));
  const fx: Fx = all.find((f) => f.key === sel) ?? feats[0] ?? all[0];
  const [showZero, setShowZero] = useState(false);
  const comps: any[] = fx?.components ?? [];
  // по умолчанию — часть, на которую сильнее всего влияют входы с вилкой
  const defComp = useMemo(() => {
    if (!comps.length) return 0;
    let best = 0, bestW = -1;
    comps.forEach((c, i) => {
      const w = fx.inputs.filter((x: any) => x.varied && c.inputs.includes(x.id)).reduce((s: number, x: any) => s + Math.abs(x.lever?.neg ?? 0) + Math.abs(x.lever?.pos ?? 0), 0) + Math.abs(c.month.exp) * 1e-6;
      if (w > bestW) { bestW = w; best = i; }
    });
    return best;
  }, [fx?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ci, setCi] = useState(defComp);
  useEffect(() => setCi(defComp), [defComp]);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  if (!fx) return <p className="text-sm text-muted-foreground">В конфиге нет фич.</p>;
  const comp = comps[Math.min(ci, comps.length - 1)];
  const byId: Record<string, any> = Object.fromEntries(fx.inputs.map((x: any) => [x.id, x]));
  const baseFx = bf(fx);
  const baseById: Record<string, any> = Object.fromEntries((baseFx.inputs ?? []).map((x: any) => [x.id, x]));
  const ed = (id: string): Edit | undefined => {
    const b = baseById[id]?.values.exp;
    if (b == null) return undefined;
    const o = ov[fx.key]?.[id];
    return {
      value: o ?? byId[id]?.values.exp ?? b,
      base: b,
      moved: o != null && Math.abs(o - b) > 1e-12,
      set: (v) => setInput(fx.key, id, Math.abs(v - b) < 1e-12 ? null : v),
      reset: () => setInput(fx.key, id, null),
    };
  };
  const nOv = Object.values(ov).reduce((s, x) => s + Object.keys(x).length, 0);
  const nFx = Object.keys(ov[fx.key] ?? {}).length;
  const baseE = fval(baseFx, h, "exp");
  const meta = d._meta;
  const meas = (d._measures ?? []).find((m: any) => m.key === fx.key);
  const ramp = comp ? meta.ramps[comp.ramp] : null;
  const levers: FxLever[] = fx.inputs
    .filter((x: any) => x.varied && x.lever)
    .map((x: any) => ({ inp: x, a: Math.min(x.lever.neg, x.lever.pos), b: Math.max(x.lever.neg, x.lever.pos), w: Math.abs(x.lever.neg) + Math.abs(x.lever.pos) }))
    .filter((l: FxLever) => l.w > 0.5)
    .sort((a: FxLever, b: FxLever) => b.w - a.w);
  const E = fval(fx, h, "exp"), N = fval(fx, h, "neg"), P = fval(fx, h, "pos");
  const vals = comps.map((c) => ({ c, v: compVal(c, h, "exp") }));
  const plus = vals.filter((x) => x.v > 0.5), minus = vals.filter((x) => x.v < -0.5);
  const sum = (xs: { v: number }[]) => xs.reduce((s, x) => s + x.v, 0);
  const onceParts = h === "month" ? comps.filter((c) => c.window_days) : [];
  const late = fx.release?.neg && fx.release.neg !== fx.release.exp ? fx.release.neg : null;
  const cyName = String(meta.cy), nyName = String(meta.ny);
  const yearRows = comps.map((c) => ({ c, m: c.window_days ? c.month_raw.exp : c.month.exp }));
  const noMoneyCy = comps.filter((c) => c.months.exp.cy === 0 && Math.abs(c.month_raw?.exp ?? c.month.exp) > 0.5);
  const firstMinus = comps.filter((c) => c.month.exp < -0.5).map((c) => c.start).sort()[0];
  const plusLater = firstMinus ? comps.filter((c) => c.month.exp > 0.5 && c.start > firstMinus) : [];
  const minusFirst = fval(fx, "month", "exp") > 0.5 && fval(fx, "cy", "exp") < -0.5;
  const hasMinus = comps.some((c) => (c.month_raw?.exp ?? c.month.exp) < -0.5);
  const sections: [string, string][] = [["s0", "Коротко"], ["s1", "Из чего"], ["s2", "Как посчитано"], ["s3", "От чего зависит"], ["s4", "Когда деньги"], ["s5", "Как проверим"]];
  const quote = (s: string) => `«${s}»`;
  const listItem = (f: Fx) => (
    <button key={f.key} type="button" onClick={() => onSel(f.key)} title={isNeg(fval(f, h, "exp")) ? NEG_TIP : undefined}
      className={cn("mt-px flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors", isNeg(fval(f, h, "exp")) && NEG_ROW, f.key === fx.key ? "bg-foreground text-background hover:bg-foreground" : !isNeg(fval(f, h, "exp")) && "hover:bg-state-hover")}>
      <span className="min-w-0 truncate" title={f.name}>
        {Object.keys(ov[f.key] ?? {}).length > 0 && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-current align-middle" title="Входы этой фичи изменены" />}
        {f.name}
      </span>
      <b className="shrink-0 tabular-nums"><Th v={fval(f, h, "exp")} /></b>
    </button>
  );
  const top = levers.find((l) => l.inp.id === fx.main_input) ?? levers[0];
  return (
    <div className={cn("grid grid-cols-1 gap-4", !single && "@4xl:grid-cols-[250px_minmax(0,1fr)]")}>
      {!single && <aside className="self-start rounded-lg border border-border p-2.5 @4xl:sticky @4xl:top-0">
        <div className="px-2 text-[13px] font-semibold">Фичи релиза</div>
        <div className="mb-1.5 px-2 text-[11px] text-subtle-foreground">тыс. сом {hLabel(h, d)}, ожидаем</div>
        {feats.map(listItem)}
        {zero.length > 0 && <button type="button" onClick={() => setShowZero(!showZero)} className="mt-1 flex w-full items-center gap-1 px-2 py-1 text-left text-[12px] text-muted-foreground hover:text-foreground">
          <Icon name={showZero ? "ChevronDown" : "ChevronRight"} className="size-3.5" /> ещё {zero.length} фич с нулём
        </button>}
        {showZero && zero.map(listItem)}
      </aside>}
      <div className="min-w-0 space-y-4">
        <FxHead fx={fx} d={base} h={h} E={E} N={N} P={P} baseE={baseE} />
        {(nOv > 0 || wi.busy || wi.error) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border-2 border-foreground px-3 py-2 text-[12.5px]">
            <b>Изменено входов: {nOv}{nOv && nFx !== nOv ? `, у этой фичи ${nFx}` : ""}</b>
            <span className="tabular-nums">фича {hLabel(h, d)}: {th(baseE)} → <b>{th(E)}</b></span>
            <span className="tabular-nums">релиз: {th(base._total[h].exp)} → <b>{th(d._total[h].exp)}</b></span>
            <span className="text-[11.5px] text-subtle-foreground">
              {wi.error ? <span className="text-destructive-text">Ошибка: {wi.error}</span> : wi.busy ? "Считаю…" : "Правки сохраняются сами до «Сбросить» · конфиг и xlsx не меняются · те же правки в «Что если»"}
            </span>
            <Button className="ml-auto" variant="outline" size="sm" onClick={onReset}><Icon name="RotateCcw" /> Сбросить всё</Button>
          </div>
        )}
        {!comps.length ? (
          <Block title="Почему 0">
            <p className="text-[13px]">{fx.main_assumption || "Частей с деньгами нет: цепочка до денег не подтверждена данными."}</p>
            <p className="mt-2 text-[12px] text-subtle-foreground">Фичи типов C и D получают число, только если каждое звено до денег подтверждено данными (решение PO 14.11.2026).</p>
          </Block>
        ) : (
          <>
            <nav className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[12px] text-muted-foreground">
              {sections.map(([id, label], i) => (
                <span key={id} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-subtle-foreground">·</span>}
                  <button type="button" onClick={() => refs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" })} className="rounded px-1 hover:bg-state-hover hover:text-foreground">{label}</button>
                </span>
              ))}
            </nav>

            <Block sref={(el) => (refs.current.s0 = el)} title="Коротко">
              <SumRow label="Сколько">
                <b className="tabular-nums"><Th v={E} /> тыс. сом {hLabel(h, d)}</b>{h === "month" ? " на полном разгоне" : ""}.
                {" "}Вилка <span className="tabular-nums">{th(N)} … {th(P)}</span>: хуже или лучше — в 1 случае из 10.
              </SumRow>
              <SumRow label="Из чего">
                {comps.length === 1 ? <>Одна часть: {quote(comps[0].name)}.</>
                  : plus.length && minus.length ? <>Плюс: {plus.length} {parts(plus.length)} на <b className="tabular-nums">{th(sum(plus))}</b>. Минус: {minus.length === 1 ? quote(minus[0].c.name) : `${minus.length} ${parts(minus.length)}`} на <b className="tabular-nums">{th(sum(minus))}</b>. Итог {th(E)}.</>
                  : plus.length ? <>{comps.length} {parts(comps.length)}, больше всего даёт {quote([...plus].sort((a, b) => b.v - a.v)[0].c.name)} ({th([...plus].sort((a, b) => b.v - a.v)[0].v)}).</>
                  : minus.length ? <>{comps.length} {parts(comps.length)}, все с минусом. Больше всего — {quote([...minus].sort((a, b) => a.v - b.v)[0].c.name)} ({th([...minus].sort((a, b) => a.v - b.v)[0].v)}).</>
                  : <>За {h === "cy" ? cyName : nyName} денег нет: части начинают работать позже.</>}
                {onceParts.length > 0 && <> Разово, только в годах: {onceParts.map((c) => quote(c.name)).join(", ")}.</>}
              </SumRow>
              <SumRow label="Зависит от">
                {top ? <>{quote(top.inp.name)} — {LEVEL_RU[top.inp.level] ?? "уровень не указан"} ({top.inp.level}). Берём {fv(top.inp.values.neg, top.inp.unit)} … {fv(top.inp.values.pos, top.inp.unit)}{unitOf(top.inp.unit) ? ` ${unitOf(top.inp.unit)}` : ""}, итог в месяц сдвигается на <span className="tabular-nums">{th(top.a)} … {th(top.b)}</span>.{top.inp.zero != null && !zeroAtEdge(top.inp) ? <> Фича в ноль при <b className="tabular-nums">{zeroFmt(top.inp.zero, top.inp.unit)}{unitOf(top.inp.unit) ? ` ${unitOf(top.inp.unit)}` : ""}</b>{zeroInside(top.inp) ? " — это внутри вилки" : ""}.</> : top.inp.zero === null ? " В ноль не выходит." : top.inp.zero != null ? <> В негативе фича даёт 0.</> : ""}</>
                  : <>Все входы — факты, вилки нет: три сценария совпадают.</>}
              </SumRow>
              {fx.main_assumption && <SumRow label="Допущение">{fx.main_assumption}</SumRow>}
              {fx.ice && (
                <SumRow label="Для Jira">
                  Impact <b className="tabular-nums">{somN(fx.ice.impact)}</b> сом/мес · Confidence <b>{fx.ice.confidence != null ? `${fx.ice.confidence}%` : "—"}</b>
                  {" "}· Effort <b>{fx.ice.effort_hours != null ? `${fx.ice.effort_hours} ч` : "—"}</b>{fx.ice.effort_size ? ` (${fx.ice.effort_size}, ${fx.ice.effort_by ?? "—"})` : ""}
                  {" "}· ICE <b className="tabular-nums">{fx.ice.value ?? "—"}</b>
                  {fx.ice.effort_note ? <span className="block text-[11.5px] text-subtle-foreground">Effort: {fx.ice.effort_note}{fx.ice.effort_split ? ` Разбить: ${fx.ice.effort_split}` : ""}</span> : null}
                </SumRow>
              )}
              <SumRow label="Деньги">
                {slipOf(fx) ? <>В Jira — релиз {dmy(fx.jira.planned)}, по статусу «{fx.status}» ждём позже. </> : null}
                {fx.first_money && fx.first_money !== fx.release?.exp ? <>Релиз {dmy(fx.release?.exp)}, первые деньги {dmy(fx.first_money)}.</> : <>Релиз и первые деньги — {dmy(fx.release?.exp)}.</>}{late ? ` Если релиз сдвинется — ${dmy(late)}.` : ""}
              </SumRow>
            </Block>

            <Block sref={(el) => (refs.current.s1 = el)} title="Из чего складывается" hint={`тыс. сом ${hLabel(h, d)} · клик по строке — как посчитана часть`}>
              <PartsBars comps={comps} h={h} total={E} sel={ci} onSel={setCi} />
            </Block>

            {comp && (
              <Block sref={(el) => (refs.current.s2 = el)} title={<>Как посчитана часть {quote(comp.name)}</>} hint="ожидаемый сценарий · число во входе можно поменять: всё ниже пересчитается">
                <CompCalc comp={comp} fx={fx} h={h} d={d} byId={byId} ed={ed} />
              </Block>
            )}

            <Block sref={(el) => (refs.current.s3 = el)} title="От чего зависит" hint="три сценария фичи и входы, которые двигают итог · негатив и позитив — входы независимы: каждый отдельно, итог — корень из суммы квадратов">
              <div className="mb-4 grid grid-cols-3 gap-2">
                {(["neg", "exp", "pos"] as S[]).map((s) => (
                  <div key={s} className={cn("rounded-lg border px-2 py-2 text-center", s === "exp" ? "border-foreground/40 bg-state-active" : "border-border")}>
                    <div className="text-[11.5px] text-muted-foreground">{s === "neg" ? "Негатив" : s === "exp" ? "Ожидаем" : "Позитив"}</div>
                    <div className="text-xl font-semibold tabular-nums"><Th v={fval(fx, h, s)} /></div>
                    <div className="text-[10.5px] text-subtle-foreground">{s === "exp" ? "среднее" : s === "neg" ? "хуже — в 1 случае из 10" : "лучше — в 1 случае из 10"}</div>
                  </div>
                ))}
              </div>
              {levers.length ? (
                <>
                  <Tornado levers={levers} total={fval(fx, "month", "exp")} main={fx.main_input} />
                  <p className="mt-2 text-[11.5px] text-subtle-foreground">Полоса — насколько изменится итог фичи в месяц, если только этот вход взять из негатива или позитива. Сверху — самый сильный. Красная линия — итог фичи = 0: полоса за ней значит, что один этот вход может перевернуть знак фичи.</p>
                </>
              ) : <p className="text-[12.5px] text-subtle-foreground">Все входы — факты, вилки нет: три сценария совпадают.</p>}
            </Block>

            <Block sref={(el) => (refs.current.s4 = el)} title="Когда придут деньги" hint="год = в месяц × месяцев эффекта">
              <p className="mb-3 text-[12.5px]">
                Релиз: ожидаем <b>{dmy(fx.release?.exp)}</b>{late ? <>, поздний срок <b>{dmy(late)}</b></> : null}
                <span className="text-subtle-foreground"> · по статусу Jira «{fx.status}»{fx.jira?.planned ? `, в Jira — релиз ${dmy(fx.jira.planned)}` : ""}</span>
              </p>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                <div className="min-w-[420px] flex-1 overflow-x-auto">
                  <table className="w-full text-[12px] tabular-nums">
                    <thead>
                      <tr className="text-right text-[11px] text-subtle-foreground">
                        <th className="py-1 pr-2 text-left font-medium">Часть</th>
                        <th className="px-1.5 font-medium">деньги с</th>
                        <th className="px-1.5 font-medium">в месяц</th>
                        <th className="px-1.5 font-medium" title="Месяцев полного эффекта с учётом разгона">× мес. {cyName}</th>
                        <th className="px-1.5 font-medium">= {cyName}</th>
                        <th className="px-1.5 font-medium" title="Месяцев полного эффекта с учётом разгона">× мес. {nyName}</th>
                        <th className="pl-1.5 font-medium">= {nyName}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearRows.map(({ c, m }, i) => (
                        <tr key={i} className={cn("border-t border-border-seam text-right", i === ci && "bg-state-active")}>
                          <td className="max-w-[260px] truncate py-1.5 pr-2 text-left" title={c.name}>{c.name}</td>
                          <td className="px-1.5 text-muted-foreground">{dmy(c.start)}</td>
                          <td className="px-1.5"><Th v={m} />{c.window_days ? <span className="ml-1 text-[10.5px] text-subtle-foreground">{c.window_days} дн.</span> : null}</td>
                          <td className="px-1.5 text-muted-foreground">{num(c.months.exp.cy, 2)}</td>
                          <td className="px-1.5 font-semibold"><Th v={c.cy.exp} /></td>
                          <td className="px-1.5 text-muted-foreground">{num(c.months.exp.ny, 2)}</td>
                          <td className="pl-1.5 font-semibold"><Th v={c.ny.exp} /></td>
                        </tr>
                      ))}
                      <tr className="border-t border-border text-right font-semibold">
                        <td className="py-1.5 pr-2 text-left">Итог фичи</td><td /><td className="px-1.5"><Th v={fval(fx, "month", "exp")} /></td><td />
                        <td className="px-1.5"><Th v={fval(fx, "cy", "exp")} /></td><td /><td className="pl-1.5"><Th v={fval(fx, "ny", "exp")} /></td>
                      </tr>
                      {late && (
                        <tr className="text-right text-subtle-foreground">
                          <td className="py-1 pr-2 text-left" colSpan={4}>если релиз {dmy(late)}</td>
                          <td className="px-1.5">{th(fx.late.cy)}</td><td /><td className="pl-1.5">{th(fx.late.ny)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11.5px] leading-snug text-muted-foreground">
                    {fval(fx, "month", "exp") > 0.5 && fval(fx, "cy", "exp") < -0.5 && (
                      <li>{cyName} в минусе, хотя в месяц плюс: {plusLater.length ? <>минус действует с {dmy(firstMinus)}, а часть плюса приходит позже</> : "плюс-части разгоняются медленнее минуса"}.</li>
                    )}
                    {noMoneyCy.length > 0 && <li>В {cyName} денег нет от {noMoneyCy.map((c) => `${quote(c.name)} (с ${dmy(c.start)})`).join(", ")}{minusFirst ? "" : ": они стартуют в следующем году"}.</li>}
                    <li>Месяцы эффекта — от старта денег до конца года, с учётом разгона: в первые дни работает только часть эффекта.</li>
                  </ul>
                </div>
                {ramp && comp && (
                  <div className="w-[250px] shrink-0">
                    <div className="mb-1 text-[12px] font-medium">Разгон части {quote(comp.name)}</div>
                    {Object.keys(ramp).length > 1 ? <RampCurve ramp={ramp} /> : <p className="rounded-lg bg-surface-recessed px-3 py-2 text-[12px] text-muted-foreground">Разгона нет: полный эффект с первого дня денег.</p>}
                    <p className="mt-1 text-[11px] leading-snug text-subtle-foreground">
                      Доля полного эффекта по дням после старта денег{comp.ramp_text ? `: ${comp.ramp_text}` : ""}{comp.lag_days ? `. Деньги через ${comp.lag_days} дн. после релиза` : ""}.
                    </p>
                  </div>
                )}
              </div>
            </Block>

            <Block sref={(el) => (refs.current.s5 = el)} title="Как проверим">
              <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
                <div className={cn("rounded-lg border p-3 text-[12.5px]", fx.breakeven ? "border-2 border-foreground" : "border-border")}>
                  <b className="mb-1 block">Порог окупаемости</b>
                  {!fx.breakeven && top?.inp.zero != null && (
                    <div className="mb-1.5">
                      Калькулятор: фича в ноль, если {quote(top.inp.name)} = <b className="tabular-nums">{zeroFmt(top.inp.zero, top.inp.unit)}{unitOf(top.inp.unit) ? ` ${unitOf(top.inp.unit)}` : ""}</b>. Ожидаем {fv(top.inp.values.exp, top.inp.unit)}{unitOf(top.inp.unit) ? ` ${unitOf(top.inp.unit)}` : ""}.
                    </div>
                  )}
                  <span className="text-muted-foreground">
                    {fx.breakeven || (!fx.mechanics?.length
                      ? `В конфиге не записан: конфиг собран до методики v3.${hasMinus && top?.inp.zero == null ? " У фичи есть часть с минусом — порог нужен: при каком значении фича выходит в ноль." : ""}`
                      : fx.mechanics.some((m: string) => COST_MECH.includes(m))
                        ? "В конфиге не записан, а нужен: в фиче скидка, бонусы или новая цена."
                        : "Не нужен: фича ничего не тратит.")}
                  </span>
                </div>
                <div className="rounded-lg border border-border p-3 text-[12.5px]">
                  <b className="mb-1 block">Что замерим после релиза</b>
                  {fx.measure ? (
                    <div className="space-y-1.5 text-muted-foreground">
                      <div className="text-foreground">{fx.measure.metric}{fx.measure.unit ? `, ${fx.measure.unit}` : ""}</div>
                      <Triple neg={fv(fx.measure.neg, fx.measure.unit === "доля" ? "доля" : "")} exp={fv(fx.measure.exp, fx.measure.unit === "доля" ? "доля" : "")} pos={fv(fx.measure.pos, fx.measure.unit === "доля" ? "доля" : "")} />
                      <div className="text-[11.5px]">{fx.measure.method}{fx.measure.separable ? ` · отделим от других изменений: ${fx.measure.separable}` : ""}</div>
                      {meas?.dates && <div className="text-[11.5px]">Даты замера: {meas.dates}</div>}
                      {fx.measure.draft && <div className="text-[11px] text-subtle-foreground">Черновик ИИ: проверить метрику и способ</div>}
                    </div>
                  ) : <span className="text-muted-foreground">Не задано{meta.v3 ? "" : ": конфиг собран до методики v3"}. До релиза записать: какую метрику смотрим и сколько ждём.</span>}
                </div>
              </div>
              {checksOf(base, fx.key).length > 0 && (
                <div className="mt-3 rounded-lg border p-3 text-[12.5px]" style={{ borderColor: tint(C_WARN, 45) }}>
                  <b className="mb-1 block" style={{ color: C_WARN }}>Сработали проверки калькулятора · {checksOf(base, fx.key).length}</b>
                  {checksOf(base, fx.key).map((c: any, i: number) => (
                    <div key={i} className="border-t border-border-seam py-1 first:border-t-0">
                      <div>{c.check}</div>
                      <div className="text-[11.5px] text-muted-foreground">{String(c.where).split(" · ").slice(1).join(" · ")}{c.note ? ` — ${c.note}` : ""}</div>
                    </div>
                  ))}
                </div>
              )}
              {fx.prev_estimate?.value != null && (
                <p className="mt-3 text-[12px] text-muted-foreground">
                  Прошлая оценка {fx.prev_estimate.date}: {th(fx.prev_estimate.value)} тыс. в месяц{fx.prev_reason ? `. Почему иначе: ${fx.prev_reason}` : ""}
                </p>
              )}
            </Block>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Экран 3. Что если ----------
type Lever = { key: string; fname: string; inp: any; w: number };
const ROWW = "grid grid-cols-1 items-center gap-x-3 gap-y-1.5 @4xl:grid-cols-[minmax(180px,290px)_124px_230px_minmax(0,1fr)]";
function WhatIfTab({ d, h, setH, ov, setOv, setInput, k, setK, late, setLate, wi, onPick }: {
  d: Data; h: H; setH: (h: H) => void; ov: Inputs; setOv: (o: Inputs) => void; setInput: (key: string, id: string, v: number | null) => void; k: number | null; setK: (k: number | null) => void;
  late: boolean; setLate: (v: boolean) => void; wi: { data: Data | null; busy: boolean; ms: number | null; error: string | null }; onPick: (k: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const meta = d._meta;
  const levers: Lever[] = useMemo(() => {
    const out: Lever[] = [];
    for (const f of d._explain as Fx[]) for (const x of f.inputs) {
      if (!x.varied || !x.lever) continue;
      const w = Math.abs(x.lever.neg) + Math.abs(x.lever.pos);
      if (w > 0.5) out.push({ key: f.key, fname: f.name, inp: x, w });
    }
    return out.sort((a, b) => b.w - a.w);
  }, [d]);
  const L = Math.max(1, ...levers.map((l) => Math.max(Math.abs(l.inp.lever.neg), Math.abs(l.inp.lever.pos))));
  const LX = (v: number) => 50 + (v / L) * 36;
  const shown = showAll ? levers : levers.slice(0, 7);
  const cur = wi.data ?? d;
  const useLate = late && h !== "month";
  const totalOf = (x: Data) => (useLate ? x._total_late[h] : x._total[h].exp);
  const finOk = meta.v3 && meta.k_config != null;
  const finOf = (x: Data) => (useLate ? x._fin_total[`late_${h}`] : x._fin_total[h].exp);
  const featOf = (x: Data, key: string) => (useLate ? x[key].late[h] : x[key].vals[h].exp);
  const changed = (d._explain as Fx[]).filter((f) => Math.abs(featOf(cur, f.key) - featOf(d, f.key)) > 0.5);
  const nOv = Object.values(ov).reduce((s, x) => s + Object.keys(x).length, 0);
  const leverIds = new Set(levers.map((l) => `${l.key}:${l.inp.id}`));
  const mainOf: Record<string, string | null> = Object.fromEntries((d._explain as Fx[]).map((f) => [f.key, f.main_input ?? null]));
  const fxOf: Record<string, Fx> = Object.fromEntries((d._explain as Fx[]).map((f) => [f.key, f]));
  // входы без ползунка: без вилки или со слабым влиянием — правятся в карточке фичи
  const rest = (d._explain as Fx[]).map((f) => ({ f, inputs: f.inputs.filter((x: any) => !leverIds.has(`${f.key}:${x.id}`)) })).filter((g) => g.inputs.length);
  const nRest = rest.reduce((s, g) => s + g.inputs.length, 0);
  const kOpts = finOk ? [{ v: meta.k_config as number, label: `3 мес. ${Math.round(meta.k_config * 100)}%` }, ...meta.k_months.map((m: any) => ({ v: m.k as number, label: `${MONTHS_RU[Number(m.month.slice(5, 7)) - 1]} ${Math.round(m.k * 100)}%` }))] : [];
  const setVal = (l: Lever, v: number) => setInput(l.key, l.inp.id, Math.abs(v - l.inp.values.exp) < 1e-12 ? null : v);
  const before = totalOf(d), after = totalOf(cur), delta = after - before;
  return (
    <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 rounded-xl border border-border px-4 pb-3 pt-3.5">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[14px] font-semibold">Что двигает итог релиза</h3>
          <span className="text-[11.5px] text-subtle-foreground">входы, которые мы не знаем точно · сверху — самые сильные · <span style={{ color: C_ATT }}>★</span> — главный вход фичи · янтарная метка — здесь фича в ноль</span>
        </div>
        {!levers.length && <p className="text-[12.5px] text-muted-foreground">В конфиге нет входов с вилкой.</p>}
        <div className="hidden grid-cols-[minmax(180px,290px)_124px_230px_minmax(0,1fr)] gap-x-3 border-b border-border-seam pb-1.5 text-[11px] text-subtle-foreground @4xl:grid">
          <span>Вход и фича</span><span>Откуда число</span><span>Значение: негатив — ожидаем — позитив</span><span>Сдвиг итога, тыс. сом в месяц</span>
        </div>
        {shown.map((l) => {
          const x = l.inp, v = x.values;
          const lo = Math.min(v.neg, v.pos), hi = Math.max(v.neg, v.pos);
          const value = ov[l.key]?.[x.id] ?? v.exp;
          const moved = ov[l.key]?.[x.id] != null && Math.abs(value - v.exp) > 1e-12;
          const P = (val: number) => (hi > lo ? ((val - lo) / (hi - lo)) * 100 : 50);
          const a = Math.min(x.lever.neg, x.lever.pos), b = Math.max(x.lever.neg, x.lever.pos);
          const dl = wi.data ? wi.data[l.key].vals.month.exp - d[l.key].vals.month.exp : 0;
          const fx = fxOf[l.key] ?? {};
          const negLeft = v.neg <= v.pos;
          // трек ползунка: от нуля фичи в сторону негатива — красный, в сторону позитива — зелёный
          let track: string;
          if (zeroInside(x)) {
            const pz = P(x.zero);
            track = negLeft
              ? `linear-gradient(90deg, ${tint(C_NEG, 75)}, ${tint(C_NEG, 22)} ${pz}%, ${tint(C_POS, 22)} ${pz}%, ${tint(C_POS, 75)})`
              : `linear-gradient(90deg, ${tint(C_POS, 75)}, ${tint(C_POS, 22)} ${pz}%, ${tint(C_NEG, 22)} ${pz}%, ${tint(C_NEG, 75)})`;
          } else if (fval(fx, "month", "exp") < -0.5) {
            track = `linear-gradient(${negLeft ? 90 : 270}deg, ${tint(C_NEG, 70)}, ${tint(C_NEG, 12)})`;
          } else {
            track = `linear-gradient(${negLeft ? 90 : 270}deg, ${tint(C_POS, 12)}, ${tint(C_POS, 70)})`;
          }
          return (
            <div key={`${l.key}:${x.id}`} className={cn(ROWW, "relative border-t border-border-seam py-2.5", moved && "-mx-4 px-4")}
              style={moved ? { background: tint(C_ATT, 9), boxShadow: `inset 3px 0 0 ${C_ATT}` } : undefined}>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium" title={x.name}>{mainOf[l.key] === x.id && <MainStar />}{x.name}</div>
                <button type="button" onClick={() => onPick(l.key)} title="Открыть карточку фичи" className="flex min-w-0 max-w-full items-center gap-1.5 text-[11px] text-subtle-foreground hover:text-foreground">
                  <i className="inline-block size-2 shrink-0 rounded-full" style={{ background: stripeBg(linesOf(fx)) }} />
                  <span className="min-w-0 truncate">{l.fname}</span>
                  {isNeg(featOf(cur, l.key)) && <IssChip id="minus" />}
                </button>
                {x.zero !== undefined && <div className="truncate text-[11px]"><ZeroNote inp={x} /></div>}
              </div>
              <div><LvlWord level={x.level} /></div>
              <div className="pr-4">
                <div className="relative h-[18px]">
                  <span className="pointer-events-none absolute inset-x-0 top-[6px] h-1.5 rounded-full" style={{ background: track }} />
                  <span className="pointer-events-none absolute top-[3px] h-3 w-0.5 -translate-x-1/2 bg-foreground/60" style={{ left: `${P(v.exp)}%` }} title="ожидаем (из конфига)" />
                  {zeroInside(x) && <span className="pointer-events-none absolute -top-0.5 h-[22px] w-0.5 -translate-x-1/2" style={{ left: `${P(x.zero)}%`, background: C_ATT, boxShadow: `0 0 6px ${C_ATT}` }} title="Здесь фича выходит в ноль (остальные входы — ожидаемые)" />}
                  <input type="range" min={lo} max={hi} step={(hi - lo) / 200 || 1} value={value} aria-label={x.name}
                    onChange={(e) => setVal(l, Number(e.target.value))} className="fr-range relative w-full"
                    style={{ ["--fr-thumb" as any]: moved ? C_ATT : "var(--foreground)" } as CSSProperties} />
                </div>
                <div className="flex justify-between text-[11px] tabular-nums text-subtle-foreground">
                  <span>{fv(lo, x.unit)}<span className="ml-1 opacity-70">{negLeft ? "негатив" : "позитив"}</span></span>
                  <span><span className="mr-1 opacity-70">{negLeft ? "позитив" : "негатив"}</span>{fv(hi, x.unit)}</span>
                </div>
                <div className="mt-1"><InlineEdit inp={x} value={value} base={v.exp} set={(n) => setInput(l.key, x.id, n)} /></div>
                {(value < lo || value > hi) && <div className="text-[11px] text-subtle-foreground">за пределами вилки</div>}
              </div>
              <div className="relative h-7">
                <span className="absolute inset-y-0 border-l border-dashed border-foreground/30" style={{ left: `${LX(0)}%` }} />
                {a < 0 && <span className="absolute top-2 h-3 rounded-l-sm" style={{ left: `${LX(a)}%`, width: `${LX(Math.min(0, b)) - LX(a)}%`, background: `linear-gradient(270deg, ${tint(C_NEG, 30)}, ${C_NEG})` }} />}
                {b > 0 && <span className="absolute top-2 h-3 rounded-r-sm" style={{ left: `${LX(Math.max(0, a))}%`, width: `${LX(b) - LX(Math.max(0, a))}%`, background: `linear-gradient(90deg, ${tint(C_POS, 30)}, ${C_POS})` }} />}
                <span className="absolute top-[7px] -translate-x-full pr-1.5 text-[11px] font-semibold tabular-nums" style={{ left: `${LX(Math.min(0, a))}%`, color: a < -0.5 ? C_NEG : "var(--muted-foreground)" }}>{th(a)}</span>
                <span className="absolute top-[7px] pl-1.5 text-[11px] font-semibold tabular-nums" style={{ left: `${LX(Math.max(0, b))}%`, color: b > 0.5 ? C_POS : "var(--muted-foreground)" }}>{th(b)}</span>
                {moved && <span className="absolute top-0.5 h-6 w-1 -translate-x-1/2 rounded" style={{ left: `${LX(Math.max(-L, Math.min(L, dl)))}%`, background: C_ATT, boxShadow: `0 0 8px ${C_ATT}` }} title={`сдвиг фичи ${th(dl)}`} />}
              </div>
            </div>
          );
        })}
        {levers.length > 7 && (
          <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1 flex items-center gap-1.5 border-t border-border-seam pt-2 text-[12px] text-muted-foreground hover:text-foreground">
            <Icon name={showAll ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
            {showAll ? "Свернуть" : `ещё ${levers.length - 7} входов с меньшим влиянием`}
          </button>
        )}
        {nRest > 0 && (
          <div className="mt-3 border-t border-border pt-3">
            <div className="text-[13px] font-semibold">Остальные входы · {nRest}</div>
            <div className="mb-1.5 text-[11.5px] text-subtle-foreground">без вилки или слабо влияют · правятся в карточке фичи — клик по фиче</div>
            <div className="grid grid-cols-1 gap-x-5 @3xl:grid-cols-2">
              {rest.map(({ f, inputs }) => {
                const nMoved = inputs.filter((x: any) => ov[f.key]?.[x.id] != null).length;
                const dlt = featOf(cur, f.key) - featOf(d, f.key);
                return (
                  <button key={f.key} type="button" onClick={() => onPick(f.key)} title="Открыть карточку фичи"
                    className="flex w-full items-center gap-2 border-t border-border-seam py-1.5 text-left text-[12.5px] hover:bg-state-hover">
                    <i className="inline-block h-4 w-1 shrink-0 rounded-full" style={{ background: stripeBg(linesOf(f)) }} />
                    <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                    {nMoved > 0 && <span className="shrink-0 text-[11px] font-medium" style={{ color: C_ATT }}>изменено {nMoved}</span>}
                    <span className="shrink-0 text-[11px] text-subtle-foreground">{inputs.length} вх.</span>
                    {Math.abs(dlt) > 0.5 && <b className="shrink-0 text-[11.5px] tabular-nums"><Th v={dlt} /></b>}
                    <Icon name="ChevronRight" className="size-3.5 shrink-0 text-subtle-foreground" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <div className="space-y-4">
        <section className="relative overflow-hidden rounded-xl border px-4 py-4"
          style={{ borderColor: tint("var(--fr-promo)", 35), background: `radial-gradient(420px 200px at 0% 0%, ${tint("var(--fr-pop)", 14)}, transparent 70%), radial-gradient(420px 200px at 100% 100%, ${tint("var(--fr-promo)", 14)}, transparent 70%)` }}>
          <h3 className="text-[13.5px] font-semibold">Итог релиза, {hLabel(h, d)}{useLate ? ", поздний срок" : ""}</h3>
          <div className="mt-2 flex items-end gap-3">
            <div><div className="text-[11.5px] text-muted-foreground">было</div><div className="text-[22px] font-semibold tabular-nums text-subtle-foreground">{th(before)}</div></div>
            <div className="pb-1 text-xl text-subtle-foreground">→</div>
            <div><div className="text-[11.5px] text-muted-foreground">стало</div><div className="text-[36px] font-bold leading-none tabular-nums" style={bigStyle(after)}>{wi.busy && !wi.data ? "…" : th(after)}</div></div>
          </div>
          {Math.abs(delta) > 0.5 && <div className="mt-2"><Pill c={delta > 0 ? C_POS : C_NEG}>{delta > 0 ? "▲" : "▼"} {th(delta)} тыс. сом</Pill></div>}
          {finOk && <Row label="Итог финотчёта" value={<><Th v={finOf(d)} /> → <Th v={finOf(cur)} /></>} />}
          <p className="mt-2 text-[11.5px] text-subtle-foreground">
            {wi.error ? <span className="text-destructive-text">Ошибка: {wi.error}</span> : wi.busy ? "Считаю…" : nOv || k != null ? `пересчёт ${wi.ms != null ? (wi.ms / 1000).toFixed(1).replace(".", ",") + " с" : ""}` : "Двигайте ползунки или меняйте числа слева"}
          </p>
        </section>
        <section className="rounded-xl border border-border px-4 py-3.5">
          <h3 className="mb-1.5 text-[13.5px] font-semibold">Что изменилось</h3>
          {changed.length ? changed.map((f) => (
            <button key={f.key} type="button" onClick={() => onPick(f.key)} className="flex w-full items-center gap-2 border-t border-border-seam py-1.5 text-left text-[12.5px] first:border-t-0 hover:bg-state-hover">
              <i className="inline-block h-4 w-1 shrink-0 rounded-full" style={{ background: stripeBg(linesOf(f)) }} />
              <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
              <span className="shrink-0 text-[12px] tabular-nums"><Th v={featOf(d, f.key)} /> → <b><Th v={featOf(cur, f.key)} /></b></span>
            </button>
          )) : <p className="text-[12px] text-subtle-foreground">Пока ничего</p>}
          {changed.length > 0 && <Row muted label="Остальные фичи" value="без изменений" />}
        </section>
        <Block title="Общие настройки" className="rounded-xl">
          <div className="space-y-2.5 text-[12.5px]">
            <div className="flex items-center justify-between gap-2">
              <span>Период</span>
              <Seg value={h} onChange={setH} options={[{ v: "month", label: "в месяц" }, { v: "cy", label: String(meta.cy) }, { v: "ny", label: String(meta.ny) }]} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Срок релизов</span>
              <Seg value={late ? "late" : "exp"} disabled={h === "month"} onChange={(v) => setLate(v === "late")} options={[{ v: "exp", label: "ожидаем" }, { v: "late", label: "поздний" }]} />
            </div>
            {h === "month" && <p className="text-[11px] text-subtle-foreground">На «в месяц» срок не влияет: это эффект на полном разгоне</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span title="Какая доля трат на услуги доходит до итога финотчёта">k: доля трат в финотчёте</span>
              {finOk ? <Seg value={k ?? meta.k_config} onChange={(v) => setK(Math.abs(v - meta.k_config) < 1e-12 ? null : v)} options={kOpts} /> : <span className="text-[11.5px] text-subtle-foreground">не задан в конфиге</span>}
            </div>
          </div>
        </Block>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!nOv && k == null} onClick={() => { setOv({}); setK(null); }}><Icon name="RotateCcw" /> Сбросить</Button>
          {nOv > 0 && <span className="text-[11.5px]" style={{ color: C_ATT }}>изменено входов: {nOv}</span>}
        </div>
        <p className="text-[11.5px] leading-snug text-subtle-foreground">Правки сохраняются сами для этого релиза, пока не нажать «Сбросить». Конфиг и отчёт не меняются. Считает тот же калькулятор, что и xlsx.</p>
      </div>
    </div>
  );
}

// ---------- Экран 4. Шпаргалка ----------
// ---------- Экран «Проверки»: лист «Проверки» калькулятора (раздел 8 методики) ----------
type CheckRow = { check: string; where: string; status: string; note: string };
const CHECK_C: Record<string, string> = { "сработала": C_WARN, "с причиной": C_INFO, "прошла": C_POS, "к сведению": "var(--muted-foreground)" };
const CHECK_ST: Record<string, string> = { "сработала": "text-destructive-text", "с причиной": "text-warning-text", "прошла": "text-success", "к сведению": "text-muted-foreground" };
function ChecksTab({ d, onPick }: { d: Data; onPick: (k: string) => void }) {
  const [all, setAll] = useState(false);
  const rows: CheckRow[] = d._check_rows ?? [];
  const nameOf: Record<string, string> = Object.fromEntries((d._explain as Fx[]).map((f) => [f.key, f.name]));
  const fxC: Record<string, Fx> = Object.fromEntries((d._explain as Fx[]).map((f) => [f.key, f]));
  const groups = [...new Set(rows.map((r) => r.check))].map((name) => {
    const rs = rows.filter((r) => r.check === name);
    return {
      name, rows: rs,
      hit: rs.filter((r) => r.status === "сработала").length,
      why: rs.filter((r) => r.status === "с причиной").length,
      info: rs.every((r) => r.status === "к сведению"),
      passed: rs.every((r) => r.status === "прошла"),
    };
  });
  const rank = (g: (typeof groups)[number]) => (g.hit ? 0 : g.why ? 1 : g.info ? 2 : 3);
  groups.sort((a, b) => rank(a) - rank(b) || b.hit - a.hit);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const nHit = groups.reduce((acc, g) => acc + g.hit, 0), nWhy = groups.reduce((acc, g) => acc + g.why, 0);
  const real = groups.filter((g) => !g.info), nPassed = real.filter((g) => g.passed).length;
  const shown = all ? groups : groups.filter((g) => g.hit || g.why);
  // Ключ фичи из проверки связывает её с карточкой «Путь числа».
  const whereOf = (w: string) => {
    const m = /^(PRODUCT-\d+)(?: · (.*))?$/.exec(w);
    if (!m || !nameOf[m[1]]) return <span>{w === "все" ? "—" : w}</span>;
    return (
      <button type="button" onClick={() => onPick(m[1])} title="Открыть карточку фичи" className="text-left hover:underline">
        <i className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: stripeBg(linesOf(fxC[m[1]])) }} />{nameOf[m[1]]}{m[2] ? <span className="text-muted-foreground"> · {m[2]}</span> : null}
      </button>
    );
  };
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
        <KpiCard label="Сработало" value={nHit} note="Исправить или записать причину до выдачи числа" c={nHit ? C_WARN : C_POS} />
        <KpiCard label="С причиной" value={nWhy} note="Отступление от правила записано в конфиге" c={C_INFO} />
        <KpiCard label="Проверок прошло" value={`${nPassed} из ${real.length}`} note="Из проверок раздела 8 методики" c={C_POS} />
      </div>
      <Block className="mt-4" title="Проверки калькулятора" hint="как лист «Проверки» в xlsx · клик по фиче — путь числа">
        <div className="mb-2">
          <Seg value={all ? "all" : "hit"} onChange={(v) => setAll(v === "all")} options={[{ v: "hit", label: "Сработавшие" }, { v: "all", label: "Все проверки" }]} />
        </div>
        {!shown.length && <p className="text-[12.5px]" style={{ color: C_POS }}>Все проверки прошли</p>}
        {shown.map((g) => {
          const isOpen = open[g.name] ?? (g.hit > 0 || g.why > 0);
          const st = g.hit ? "сработала" : g.why ? "с причиной" : g.info ? "к сведению" : "прошла";
          const list = g.rows.filter((r) => r.status !== "прошла");
          return (
            <div key={g.name} className="border-t border-border-seam">
              <button type="button" disabled={!list.length} onClick={() => setOpen({ ...open, [g.name]: !isOpen })}
                className="flex w-full items-baseline gap-2 py-2 text-left text-[12.5px] enabled:hover:text-foreground">
                <Icon name={list.length ? (isOpen ? "ChevronDown" : "ChevronRight") : "Check"} className="size-3.5 shrink-0 self-center text-subtle-foreground" />
                <span className="min-w-0 flex-1 font-medium">{g.name}</span>
                {list.length > 0 && <span className="shrink-0 text-[11.5px] tabular-nums text-subtle-foreground">{list.length}</span>}
                <span className="shrink-0"><Pill c={CHECK_C[st] ?? "var(--muted-foreground)"}>{st}</Pill></span>
              </button>
              {isOpen && list.length > 0 && (
                <div className="mb-2 space-y-1 pl-5">
                  {list.map((r, i) => (
                    <div key={i} className="grid grid-cols-1 gap-x-3 text-[12px] @3xl:grid-cols-[minmax(200px,340px)_minmax(0,1fr)]">
                      <div className="min-w-0">{whereOf(r.where)}</div>
                      <div className="text-[11.5px] text-subtle-foreground">{r.note}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Block>
    </div>
  );
}

// ---------- Экран «Замеры»: прямая метрика с прогнозом до релиза, факт после (раздел 9 методики) ----------
function mval(v: number | null | undefined, unit: string) {
  if (v == null) return "—";
  if (unit === "доля") return pct(v);
  return fv(v, "") + (unit ? ` ${unit}` : "");
}
function MeasuresTab({ d, onPick, file, onSaved }: { d: Data; onPick: (k: string) => void; file: string | null; onSaved: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [edit, setEdit] = useState<string | null>(null);
  const [fd, setFd] = useState({ date: "", value: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ms: any[] = d._measures ?? [];
  const feats = (d._explain as Fx[]).filter(nonzero);
  const fxOf: Record<string, Fx> = Object.fromEntries((d._explain as Fx[]).map((f) => [f.key, f]));
  const missing = feats.filter((f) => !ms.some((m) => m.key === f.key));
  const today: string = String(d._meta.assessed ?? "").slice(0, 10);
  const upcoming = ms.flatMap((m) => (m.date_list ?? []).map((dt: string) => ({ dt, m }))).filter((x) => x.dt >= today).sort((a, b) => a.dt.localeCompare(b.dt));
  const next = upcoming[0];
  const withFact = ms.filter((m) => m.facts?.length);
  const drafts = ms.filter((m) => m.draft).length;
  const reg = d._registry;
  const past: any[][] = reg ? reg.rows.filter((r: any[]) => String(r[3] ?? "").trim() && !String(r[2] ?? "").startsWith("см.")) : [];
  const canWrite = !!d._meta.pool && !!file;
  const colorOf = (key: string) => lineColor(linesOf(fxOf[key] ?? {})[0]);
  // календарь: даты замеров с сегодняшнего дня, точка — фича цветом строки
  const byDate = new Map<string, any[]>();
  for (const x of upcoming) { if (!byDate.has(x.dt)) byDate.set(x.dt, []); byDate.get(x.dt)!.push(x.m); }
  const allDates = [...byDate.keys()].sort();
  const t0 = Date.parse(today || allDates[0] || "2026-01-01");
  const horizon = t0 + 150 * 864e5;
  const dates = allDates.filter((x) => Date.parse(x) <= horizon);
  const later = allDates.filter((x) => Date.parse(x) > horizon);
  const t1 = Math.max(t0 + 30 * 864e5, ...dates.map((x) => Date.parse(x)));
  const TX = (iso: string) => 2 + Math.max(0, Math.min(1, (Date.parse(iso) - t0) / (t1 - t0))) * 94;
  const months: string[] = [];
  for (let y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7)) + 1; ; mo++) {
    if (mo > 12) { mo = 1; y++; }
    const iso = `${y}-${String(mo).padStart(2, "0")}-01`;
    if (!Number.isFinite(y) || Date.parse(iso) > t1) break;
    months.push(iso);
  }
  const maxStack = Math.max(1, ...dates.map((x) => byDate.get(x)!.length));
  // подпись даты: снизу; если соседняя дата ближе 4,5% ширины и её подпись снизу — эта сверху
  const topLab: boolean[] = [];
  dates.forEach((x, i) => { topLab.push(i > 0 && TX(x) - TX(dates[i - 1]) < 4.5 && !topLab[i - 1]); });
  const openEdit = (m: any) => {
    const last = (m.date_list ?? []).filter((x: string) => x <= today).pop();
    setFd({ date: last ?? today, value: "" }); setEdit(m.key); setMsg(null);
  };
  const save = (m: any, del?: string) => {
    if (!file) return;
    let value: number | null = null;
    if (!del) {
      const n = Number(fd.value.replace(/\s/g, "").replace(",", "."));
      if (!fd.value.trim() || !Number.isFinite(n)) { setMsg("Введите число"); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fd.date)) { setMsg("Введите дату"); return; }
      value = m.unit === "доля" ? n / 100 : n;
    }
    setBusy(true); setMsg(null);
    rpc.call("measure_fact", { file, key: m.key, date: del ?? fd.date, value }).then(
      (r: any) => { setBusy(false); if (!r.ok) { setMsg(r.message ?? "Не записалось"); return; } if (!del) setEdit(null); onSaved(); },
      (e: unknown) => { setBusy(false); setMsg(errText(e)); },
    );
  };
  const ratioC = (txt: string) => {
    if (/≤|<|нет/.test(txt)) return C_WARN;
    const n = Number((/\d+(?:[,.]\d+)?/.exec(txt)?.[0] ?? "").replace(",", "."));
    return !Number.isFinite(n) || !/\d/.test(txt) ? "var(--muted-foreground)" : n >= 0.8 && n <= 1.25 ? C_POS : C_WARN;
  };
  const cols = "grid grid-cols-[minmax(200px,1.4fr)_88px_minmax(190px,1fr)_minmax(120px,170px)_110px_110px] items-start gap-x-3";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <KpiCard label="Метрика записана" value={`${ms.length} из ${feats.length}`} note={missing.length ? `нет метрики: ${missing.length}` : "у всех фич с числом"} c={missing.length ? C_NEG : C_POS} />
        <KpiCard label="Ближайший замер" value={next ? dmy(next.dt) : "—"} note={next ? next.m.name : "дат замера впереди нет"} c={C_INFO} />
        <KpiCard label="Метрика — черновик ИИ" value={`${drafts} из ${ms.length}`} note="проверить метрику и способ замера до релиза" c={C_AI} />
        <KpiCard label="Факт внесён" value={`${withFact.length} из ${ms.length}`} note={canWrite ? "кнопка «+ факт» в строке фичи" : "факт — в releases/features.json"} c={C_POS} />
      </div>
      {dates.length > 0 && (
        <section className="rounded-xl border border-border px-4 pb-3 pt-3.5">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-[14px] font-semibold">Календарь замеров</h3>
            <span className="text-[11.5px] text-subtle-foreground">точка — фича цветом строки финотчёта · наведите — какие фичи · 5 месяцев вперёд</span>
            {later.length > 0 && <span className="ml-auto text-[11.5px] text-muted-foreground">позже: {later.map((x) => `${dmy(x)} (${byDate.get(x)!.length})`).join(", ")}</span>}
          </div>
          <div className="relative" style={{ height: 60 + maxStack * 13 }}>
            <span className="absolute inset-x-0 h-px bg-border" style={{ bottom: 24 }} />
            <span className="absolute border-l border-dashed" style={{ left: `${TX(today)}%`, top: 0, bottom: 24, borderColor: C_INFO }} />
            <span className="absolute text-[10.5px] font-semibold" style={{ left: `calc(${TX(today)}% + 4px)`, top: 0, color: C_INFO }}>сегодня {dm(today)}</span>
            {months.map((mo) => (
              <span key={mo} className="absolute -translate-x-1/2 text-[10.5px] text-subtle-foreground" style={{ left: `${TX(mo)}%`, bottom: 4 }}>
                {MONTHS_RU[Number(mo.slice(5, 7)) - 1]}{mo.slice(5, 7) === "01" ? ` ${mo.slice(0, 4)}` : ""}
              </span>
            ))}
            {dates.map((dt, i) => {
              const list = byDate.get(dt)!;
              const isNext = dt === next?.dt;
              const crowd = topLab[i];
              return (
                <div key={dt} className="absolute flex -translate-x-1/2 flex-col-reverse items-center gap-[3px]" style={{ left: `${TX(dt)}%`, bottom: 28 }}
                  title={`${dmy(dt)}: ${list.map((m) => m.name).join(", ")}`}>
                  {!crowd && <span className="text-[10.5px] font-semibold tabular-nums" style={{ color: isNext ? C_INFO : "var(--muted-foreground)" }}>{dm(dt)}</span>}
                  {list.map((m) => <i key={m.key} className="inline-block size-2.5 rounded-full" style={{ background: colorOf(m.key), boxShadow: `0 0 6px ${colorOf(m.key)}` }} />)}
                  {crowd && <span className="text-[10.5px] font-semibold tabular-nums" style={{ color: isNext ? C_INFO : "var(--muted-foreground)" }}>{dm(dt)}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}
      <section className="rounded-xl border border-border px-4 pb-3 pt-3.5">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-[14px] font-semibold">Что и когда мерить</h3>
          <span className="text-[11.5px] text-subtle-foreground">даты — через 14 и 30 дней от первых денег; новые услуги, бонусы и скидки — ещё через 90 · клик по фиче — карточка</span>
        </div>
        {!ms.length && <p className="text-[12.5px] text-subtle-foreground">Метрик замера нет</p>}
        {ms.length > 0 && (
          <div className="overflow-x-auto">
            <div className="min-w-[860px]">
              <div className={cn(cols, "border-b border-border-seam pb-1.5 pl-3 text-[11px] text-subtle-foreground")}>
                <span>Фича и прямая метрика</span><span className="text-right">Сейчас</span><span>Прогноз: негатив · ожидаем · позитив</span>
                <span>Даты замера</span><span className="text-right">Факт</span><span className="text-right">Факт − прогноз</span>
              </div>
              {ms.map((m) => {
                const v = m.values ?? {};
                const fact = m.facts?.length ? m.facts[m.facts.length - 1] : null;
                const diff = fact && v.exp != null ? fact.value - v.exp : null;
                const good = diff == null ? null : m.better === "lower" ? diff <= 0 : diff >= 0;
                const nextDt = (m.date_list ?? []).find((x: string) => x >= today);
                const c = colorOf(m.key);
                return (
                  <Fragment key={m.key}>
                    <div className={cn(cols, "relative border-t border-border-seam py-2 pl-3 text-[12.5px]")}>
                      <span className="absolute bottom-2 left-0 top-2 w-1 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />
                      <div className="min-w-0">
                        <button type="button" onClick={() => onPick(m.key)} className="text-left font-medium hover:underline" title="Открыть карточку фичи">{m.name}</button>
                        {isNeg(fxOf[m.key] ? fval(fxOf[m.key], "month", "exp") : null) && <span className="ml-1.5 align-middle"><IssChip id="minus" /></span>}
                        <div className="text-[11.5px] leading-snug text-muted-foreground">{m.metric}</div>
                        <div className="text-[11px] leading-snug text-subtle-foreground">{m.method}{m.separable ? ` · отделим: ${m.separable}` : ""}</div>
                        {m.draft && <span className="mt-1 inline-block" title={m.draft}><Pill c={C_AI}>черновик ИИ</Pill></span>}
                      </div>
                      <span className="text-right tabular-nums text-muted-foreground">{m.base != null ? mval(m.base, m.unit) : "—"}</span>
                      <span className="tabular-nums">
                        <span className="text-subtle-foreground">{mval(v.neg, m.unit)}</span> · <b>{mval(v.exp, m.unit)}</b> · <span className="text-subtle-foreground">{mval(v.pos, m.unit)}</span>
                        <span className="block text-[11px] text-subtle-foreground">{m.better === "lower" ? "лучше — меньше" : "лучше — больше"}</span>
                      </span>
                      <span className="flex flex-wrap gap-1 text-[11.5px] tabular-nums">
                        {(m.date_list ?? []).map((x: string) => {
                          const label = `${dm(x)}${x.slice(0, 4) !== today.slice(0, 4) ? `.${x.slice(2, 4)}` : ""}`;
                          return x === nextDt ? <Pill key={x} c={C_INFO}>{label}</Pill>
                            : x < today ? <span key={x} className="px-1 text-subtle-foreground line-through">{label}</span>
                            : <span key={x} className="rounded-full px-1.5 leading-5" style={{ color: C_INFO, boxShadow: `inset 0 0 0 1px ${tint(C_INFO, 40)}` }}>{label}</span>;
                        })}
                      </span>
                      <span className="text-right tabular-nums">
                        {fact ? <>{mval(fact.value, m.unit)}<span className="block text-[11px] text-subtle-foreground">{dmy(fact.date)}</span></> : <span className="text-subtle-foreground">—</span>}
                        {canWrite && edit !== m.key && (
                          <button type="button" onClick={() => openEdit(m)} className="mt-0.5 block w-full text-right text-[11.5px] font-medium hover:underline" style={{ color: C_INFO }}>{fact ? "изменить" : "+ факт"}</button>
                        )}
                      </span>
                      <span className="text-right tabular-nums" style={{ color: good == null ? "var(--muted-foreground)" : good ? C_POS : C_NEG }}>
                        {diff == null ? "—" : `${diff > 0 ? "+" : diff < 0 ? MINUS : ""}${mval(Math.abs(diff), m.unit)}`}
                      </span>
                    </div>
                    {edit === m.key && (
                      <div className="mb-2 ml-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]" style={{ borderColor: tint(C_INFO, 45), background: tint(C_INFO, 7) }}>
                        <b>Факт: {m.metric}</b>
                        <input type="date" value={fd.date} onChange={(e) => setFd({ ...fd, date: e.target.value })} className="rounded-md border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground" />
                        <input value={fd.value} onChange={(e) => setFd({ ...fd, value: e.target.value })} placeholder={m.unit === "доля" ? "в %" : m.unit || "число"} inputMode="decimal"
                          onKeyDown={(e) => { if (e.key === "Enter") save(m); if (e.key === "Escape") setEdit(null); }}
                          className="w-32 rounded-md border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground" autoFocus />
                        <span className="text-[11.5px] text-subtle-foreground">{m.unit === "доля" ? "%" : m.unit}</span>
                        <Button size="sm" disabled={busy} onClick={() => save(m)}>{busy ? "Пишу…" : "Сохранить"}</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdit(null)}>Отмена</Button>
                        {(m.facts ?? []).length > 0 && (
                          <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                            внесено: {(m.facts as any[]).map((x) => (
                              <span key={x.date} className="inline-flex items-center gap-1">{dmy(x.date)} — {mval(x.value, m.unit)}
                                <button type="button" disabled={busy} onClick={() => save(m, x.date)} className="text-destructive-text hover:underline" aria-label="Убрать факт">×</button>
                              </span>
                            ))}
                          </span>
                        )}
                        {msg && <span className="w-full text-[11.5px] text-destructive-text">{msg}</span>}
                        <span className="w-full text-[11px] text-subtle-foreground">Пишется в releases/features.json: measure.facts. Числа фичи не меняются: факт сверяется с прогнозом.</span>
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
        {missing.length > 0 && (
          <div className="mt-2 border-t border-border-seam pt-2 text-[12px]">
            <span className="text-destructive-text">Нет метрики: </span>
            {missing.map((f, i) => <span key={f.key}>{i ? ", " : ""}<button type="button" onClick={() => onPick(f.key)} className="hover:underline">{f.name}</button></span>)}
          </div>
        )}
      </section>
      <section className="rounded-xl border border-border px-4 pb-3 pt-3.5">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-[14px] font-semibold">Точность прошлых прогнозов</h3>
          <span className="text-[11.5px] text-subtle-foreground">лист «Реестр» конфига · факт ÷ прогноз: 1 — прогноз сбылся · зелёный — 0,8…1,25</span>
        </div>
        {!past.length && <p className="text-[12.5px] text-subtle-foreground">Замеров с фактом ещё нет</p>}
        {past.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12px]">
              <thead>
                <tr className="border-b border-border-seam text-left text-[11px] text-subtle-foreground">
                  {[0, 1, 2, 3, 4, 5].map((i) => <th key={i} className="py-1.5 pr-3 font-normal">{reg.columns[i]}</th>)}
                </tr>
              </thead>
              <tbody>
                {past.map((r, i) => (
                  <tr key={i} className="border-t border-border-seam align-top first:border-t-0">
                    <td className="py-1.5 pr-3 font-medium">{r[0]}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{r[1]}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r[2]}</td>
                    <td className="py-1.5 pr-3">{r[3]}</td>
                    <td className="py-1.5 pr-3">{String(r[4] ?? "").trim() ? <Pill c={ratioC(String(r[4]))}>{r[4]}</Pill> : "—"}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r[5]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11.5px] text-subtle-foreground">Поправку к прогнозам применяем, когда в реестре не меньше 5 замеров одной механики (раздел 9 методики). Измеренный эффект — в лист «Аналоги».</p>
      </section>
    </div>
  );
}

// ---------- Экран «В Jira»: Impact, Confidence, Effort, ICE для эпика (решение PO 18.11.2026) ----------
const somN = (v: number | null | undefined) => (v == null ? "—" : (v < 0 ? MINUS : "") + grp(v));
const ICE_NAMES: Record<string, string> = { impact: "Impact", confidence: "Confidence", effort: "Effort", ice: "ICE" };
/** карта «выручка × трудоёмкость»: x — Effort (часы, лог-шкала), y — Impact, цвет — строка финотчёта, размер — уверенность */
function IceMap({ rows, fxOf, onPick }: { rows: any[]; fxOf: Record<string, Fx>; onPick: (k: string) => void }) {
  const pts = rows.filter((r) => r.target && Math.abs(r.target.impact ?? 0) > 0.5 && (r.target.effort ?? 0) > 0);
  if (!pts.length) return <p className="py-6 text-center text-[12.5px] text-subtle-foreground">Нет эпиков с Impact и Effort</p>;
  const W = 760, H = 400, pl = 54, pr = 14, pt = 28, pb = 40;
  const efs = pts.map((r) => r.target.effort as number);
  const lx0 = Math.log2(Math.min(10, ...efs) * 0.8), lx1 = Math.log2(Math.max(200, ...efs) * 1.25);
  const xs = (e: number) => pl + ((Math.log2(e) - lx0) / (lx1 - lx0)) * (W - pl - pr);
  const { X: Yp, ticks } = scale(pts.map((r) => r.target.impact as number), 0.12);
  const ys = (v: number) => pt + (1 - Yp(v) / 100) * (H - pt - pb);
  const split = xs(60), y0 = ys(0);
  const rr = (c: number | null | undefined) => (c == null ? 7 : c >= 80 ? 14 : c >= 50 ? 11 : c >= 30 ? 9 : 7);
  const lsOf = (k: string) => linesOf(fxOf[k] ?? {});
  // точки с почти одинаковыми Effort и Impact разносим в стороны, чтобы не закрывали друг друга
  const pos: Record<string, { cx: number; cy: number; rad: number }> = {};
  const placed: { cx: number; cy: number; rad: number }[] = [];
  for (const r of [...pts].sort((a, b) => b.target.impact - a.target.impact)) {
    const cy = ys(r.target.impact), rad = rr(r.target.confidence);
    let cx = xs(r.target.effort);
    for (let k = 1; k < 8 && placed.some((p) => Math.abs(p.cx - cx) < p.rad + rad + 2 && Math.abs(p.cy - cy) < p.rad + rad + 2); k++) {
      cx = xs(r.target.effort) + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (rad + 9);
    }
    pos[r.key] = { cx, cy, rad };
    placed.push(pos[r.key]);
  }
  // подписи без наложений: справа, слева, выше, ниже — первое свободное место
  const boxes = pts.map((r) => { const { cx, cy, rad } = pos[r.key]; return { x0: cx - rad, x1: cx + rad, y0: cy - rad, y1: cy + rad }; });
  const laid = [...pts].sort((a, b) => b.target.impact - a.target.impact).map((r) => {
    const { cx, cy, rad } = pos[r.key];
    const label = shortName(fxOf[r.key]?.name ?? r.name), w = label.length * 6.4 + 4;
    const tries: [number, "start" | "end", number][] = [[cx + rad + 6, "start", 0], [cx - rad - 6, "end", 0], [cx + rad + 6, "start", -14], [cx + rad + 6, "start", 14], [cx - rad - 6, "end", -14], [cx - rad - 6, "end", 14]];
    let pick = tries[0];
    for (const t of tries) {
      const bx0 = t[1] === "start" ? t[0] : t[0] - w, by0 = cy + t[2] - 9;
      if (bx0 < pl + 2 || bx0 + w > W - 2) continue;
      if (boxes.some((b) => bx0 < b.x1 && bx0 + w > b.x0 && by0 < b.y1 && by0 + 13 > b.y0)) continue;
      pick = t;
      break;
    }
    const bx0 = pick[1] === "start" ? pick[0] : pick[0] - w;
    boxes.push({ x0: bx0, x1: bx0 + w, y0: cy + pick[2] - 9, y1: cy + pick[2] + 4 });
    return { r, cx, cy, rad, label, lx: pick[0], anchor: pick[1], dy: pick[2] };
  });
  const midY = pt + (H - pt - pb) / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <defs>
        {laid.filter((p) => lsOf(p.r.key).length > 1).map((p) => {
          const ls = lsOf(p.r.key);
          return <linearGradient key={p.r.key} id={`ice-${p.r.key}`}>{ls.map((l, i) => <stop key={l} offset={i / (ls.length - 1)} stopColor={lineColor(l)} />)}</linearGradient>;
        })}
      </defs>
      <rect x={pl} y={y0} width={W - pl - pr} height={Math.max(0, H - pb - y0)} fill={C_NEG} fillOpacity={0.08} />
      <rect x={pl} y={pt} width={Math.max(0, split - pl)} height={Math.max(0, y0 - pt)} fill={C_POS} fillOpacity={0.07} />
      <line x1={split} x2={split} y1={pt} y2={H - pb} stroke="var(--border)" strokeDasharray="3 3" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pl} x2={W - pr} y1={ys(t)} y2={ys(t)} stroke={t === 0 ? "var(--muted-foreground)" : "var(--border-seam)"} />
          <text x={pl - 8} y={ys(t) + 4} fontSize={11} textAnchor="end" fill="var(--muted-foreground)">{th(t)}</text>
        </g>
      ))}
      {[16, 40, 80, 160].map((e) => <text key={e} x={xs(e)} y={H - pb + 20} fontSize={11.5} textAnchor="middle" fill="var(--muted-foreground)">{e} ч · {e <= 16 ? "S" : e <= 40 ? "M" : e <= 80 ? "L" : "XL"}</text>)}
      <text x={pl + 8} y={pt + 14} fontSize={11} fontWeight={700} fill={C_POS}>ДЁШЕВО И В ПЛЮС</text>
      <text x={W - pr - 8} y={pt + 14} fontSize={11} fontWeight={700} textAnchor="end" fill="var(--muted-foreground)">ДОРОГО И В ПЛЮС · XL разбить</text>
      {y0 < H - pb - 16 && <text x={W - pr - 8} y={H - pb - 8} fontSize={11} fontWeight={700} textAnchor="end" fill={C_NEG}>МИНУС К ВЫРУЧКЕ</text>}
      {laid.map((p) => {
        const ls = lsOf(p.r.key), c = lineColor(ls[0]), neg = p.r.target.impact < 0;
        return (
          <g key={p.r.key} onClick={() => onPick(p.r.key)} style={{ cursor: "pointer" }}>
            <title>{`${fxOf[p.r.key]?.name ?? p.r.name}: Impact ${somN(p.r.target.impact)} сом/мес · Confidence ${p.r.target.confidence ?? "—"}% · Effort ${p.r.target.effort} ч · ICE ${p.r.target.ice ?? "—"}`}</title>
            <circle cx={p.cx} cy={p.cy} r={p.rad + 6} fill={c} opacity={0.16} />
            <circle cx={p.cx} cy={p.cy} r={p.rad} fill={ls.length > 1 ? `url(#ice-${p.r.key})` : c} stroke={neg ? C_NEG : "rgba(255,255,255,0.45)"} strokeWidth={neg ? 2.5 : 1} style={{ filter: `drop-shadow(0 0 6px ${c})` }} />
            <text x={p.lx} y={p.cy + p.dy + 4} fontSize={11.5} fontWeight={600} textAnchor={p.anchor} fill="var(--foreground)">{p.label}</text>
          </g>
        );
      })}
      <text x={14} y={midY} fontSize={11} fill="var(--muted-foreground)" textAnchor="middle" transform={`rotate(-90 14 ${midY})`}>Impact, тыс. сом в месяц</text>
    </svg>
  );
}

function JiraTab({ d, file, release, isPool, onPick }: { d: Data; file: string | null; release: string | null; isPool: boolean; onPick: (k: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [st, setSt] = useState<{ rows: any[]; at: string; sync: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ key: string; ok: boolean; error?: string }[] | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [showZero, setShowZero] = useState(false);
  const [showSplit, setShowSplit] = useState(false);
  const reload = useCallback(() => {
    if (!isPool || !file) return;
    setErr(null);
    rpc.call("jira_state", { file, release }).then((r) => setSt(r as any), (e: unknown) => setErr(errText(e)));
  }, [rpc, file, release, isPool]);
  useEffect(() => { reload(); }, [reload]);
  if (!isPool) return <Note>Запись в Jira — только из группы «По Jira» (файл features.json). Снимки не пишутся.</Note>;
  if (err) return <Note><span className="text-destructive-text">Jira: {err}</span></Note>;
  if (!st) return <p className="text-sm text-muted-foreground">Читаю поля ICE из Jira…</p>;
  const fxOf: Record<string, Fx> = Object.fromEntries(((d._explain ?? []) as Fx[]).map((f) => [f.key, f]));
  const rows = [...st.rows].sort((a, b) => (b.target?.ice ?? -1e12) - (a.target?.ice ?? -1e12));
  const est = rows.filter((r) => Math.abs(r.target?.impact ?? 0) > 0.5);
  const zeroR = rows.filter((r) => !(Math.abs(r.target?.impact ?? 0) > 0.5));
  const toWrite = rows.filter((r) => Object.keys(r.write ?? {}).length);
  const devEffort = rows.filter((r) => r.effortFrom === "Jira" && r.jira?.effort !== r.calc?.effort_hours);
  const plus = est.filter((r) => r.target.impact > 0);
  const cheap = plus.filter((r) => (r.target.effort ?? 1e9) <= 40);
  const mx = Math.max(1, ...est.map((r) => r.target.ice ?? 0));
  const usedLines = [...new Set(est.flatMap((r) => linesOf(fxOf[r.key] ?? {})))];
  const write = () => {
    if (!file) return;
    setBusy(true);
    rpc.call("jira_write", { file, release, keys: toWrite.map((r) => r.key) }).then(
      (r) => { setRes((r as any).results); setBusy(false); setConfirm(false); reload(); },
      (e: unknown) => { setErr(errText(e)); setBusy(false); setConfirm(false); },
    );
  };
  const sync = () => {
    setSyncMsg("Сверяю…");
    rpc.call("jira_sync", {}).then((r) => { setSyncMsg((r as any).message); reload(); }, (e: unknown) => setSyncMsg(errText(e)));
  };
  const iceTxt = (v: number | null | undefined) => (v == null ? "—" : v < 0 ? MINUS + grp(v) : grp(v));
  const cols = "grid grid-cols-[minmax(190px,1.3fr)_104px_92px_120px_70px_minmax(150px,1fr)_minmax(150px,1fr)] items-start gap-x-3";
  const tableRow = (r: any) => {
    const c = r.calc ?? {}, j = r.jira ?? {}, t = r.target ?? {};
    const w = Object.keys(r.write ?? {});
    const ls = linesOf(fxOf[r.key] ?? {});
    return (
      <div key={r.key} className={cn(cols, "relative border-t border-border-seam py-1.5 pl-3 text-[12.5px] tabular-nums")}
        style={isNeg(t.impact) ? { background: `linear-gradient(90deg, ${tint(C_NEG, 13)}, transparent 55%)` } : undefined}>
        <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-full" style={{ background: ls.length ? stripeBg(ls) : "var(--border)" }} />
        <span className="min-w-0">
          <button type="button" onClick={() => onPick(r.key)} className="block max-w-full truncate text-left hover:underline" title={r.name}>{r.name}</button>
          <span className="text-[11px] text-subtle-foreground">{r.key}{c.by_input ? <> · <span style={{ color: C_ATT }}>★</span> {c.by_input}</> : ""}</span>
        </span>
        <span className="text-right"><Th v={t.impact} /><span className="block text-[11px] text-subtle-foreground">{somN(t.impact)}</span></span>
        <span className="text-right">{t.confidence != null ? `${t.confidence}%` : "—"}<span className="block text-[11px] text-subtle-foreground">{c.level ?? ""}</span></span>
        <span className="text-right">{t.effort != null ? `${t.effort} ч` : "—"}<span className="block text-[11px] text-subtle-foreground">{r.effortFrom === "Jira" ? "разработчики" : c.effort_size ? `${c.effort_size} · ИИ` : "нет оценки"}</span></span>
        <span className="text-right"><span className="rounded px-1.5 py-0.5 text-[12px] font-bold" style={t.ice != null ? iceStyle(t.ice) : undefined}>{iceTxt(t.ice)}</span></span>
        <span className="text-[11.5px] text-muted-foreground">{j.impact == null && j.ice == null ? "пусто" : `${somN(j.impact)} · ${j.confidence ?? "—"} · ${j.effort ?? "—"} · ${j.ice ?? "—"}`}</span>
        <span className="flex flex-wrap gap-1">{w.length ? w.map((x) => <Pill key={x} c={C_INFO}>{ICE_NAMES[x]}</Pill>) : <Pill c={C_POS}>совпадает</Pill>}</span>
      </div>
    );
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <KpiCard label="С оценкой" value={`${est.length} из ${rows.length}`} note={zeroR.length ? `${zeroR.length} — Impact 0: путь до денег не подтверждён` : "у всех эпиков есть Impact"} c="var(--foreground)" />
        <KpiCard label="Будет записано в Jira" value={toWrite.length} note="Impact, Confidence, ICE; Effort — только в пустое поле" c={C_INFO} />
        <KpiCard label="Effort от разработчиков" value={`${devEffort.length} из ${rows.length}`} note={devEffort.length ? "ICE считается по их часам" : "сейчас Effort — оценка ИИ"} c={C_WARN} />
        <KpiCard label="Дёшево (≤ 40 ч) и в плюс" value={`${cheap.length} из ${plus.length}`} note={cheap.length ? cheap.map((r) => shortName(fxOf[r.key]?.name ?? r.name)).join(", ") : "все плюсовые — L или XL"} c={C_POS} />
      </div>
      <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0 rounded-xl border border-border px-4 pb-3 pt-3.5">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-[14px] font-semibold">Выручка × трудоёмкость</h3>
            <span className="text-[11.5px] text-subtle-foreground">цвет — строка финотчёта · размер — уверенность · клик — карточка фичи</span>
          </div>
          <IceMap rows={est} fxOf={fxOf} onPick={onPick} />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            {usedLines.map((l) => <span key={l} className="inline-flex items-center gap-1.5"><i className="inline-block size-2 rounded-full" style={{ background: lineColor(l) }} />{shortLine(l)}</span>)}
            <span className="ml-auto">размер: уверенность 20% · 50% · 80%</span>
          </div>
        </section>
        <section className="rounded-xl border border-border px-4 pb-3 pt-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[14px] font-semibold">Порядок по ICE</h3>
            <span className="text-[11px] text-subtle-foreground">ICE = Impact × Confidence ÷ 100 ÷ Effort</span>
          </div>
          <div className="my-2.5 flex flex-wrap items-center gap-2">
            {!confirm && <Button size="sm" disabled={!toWrite.length || busy} onClick={() => setConfirm(true)}>Записать в Jira · {toWrite.length}</Button>}
            {confirm && (
              <>
                <span className="text-[12px]">Запишу в {toWrite.length} эпиков. Effort разработчиков не трогаю.</span>
                <Button size="sm" disabled={busy} onClick={write}>{busy ? "Пишу…" : "Подтвердить"}</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Отмена</Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={reload}><Icon name="RotateCcw" /> Перечитать</Button>
          </div>
          {res && (
            <div className="mb-2"><Note>
              Записано: {res.filter((r) => r.ok).length} из {res.length}.
              {res.filter((r) => !r.ok).map((r) => <div key={r.key} className="text-destructive-text">{r.key}: {r.error}</div>)}
            </Note></div>
          )}
          {est.map((r, i) => {
            const ice = r.target.ice ?? 0, ls = linesOf(fxOf[r.key] ?? {});
            return (
              <button key={r.key} type="button" onClick={() => onPick(r.key)} title="Открыть карточку фичи"
                className="grid w-full grid-cols-[18px_minmax(0,1fr)_26px_84px_52px] items-center gap-2 border-t border-border-seam py-1.5 text-left text-[12.5px] hover:bg-state-hover">
                <span className="text-center text-[11px] tabular-nums text-subtle-foreground">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <i className="inline-block size-2 shrink-0 rounded-full" style={{ background: ls.length ? stripeBg(ls) : "var(--border)", boxShadow: `0 0 6px ${lineColor(ls[0])}` }} />
                  <span className="truncate">{shortName(fxOf[r.key]?.name ?? r.name, 32)}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">{r.calc?.effort_size ?? (r.target.effort ? `${r.target.effort}ч` : "—")}</span>
                <span className="block h-2 overflow-hidden rounded-full bg-foreground/10">
                  <i className="block h-full rounded-full" style={{ width: `${ice > 0 ? Math.max(3, (ice / mx) * 100) : 100}%`, background: ice > 0 ? `linear-gradient(90deg, ${tint(C_POS, 40)}, ${C_POS})` : tint(C_NEG, 70) }} />
                </span>
                <b className="text-right tabular-nums" style={{ color: ice > 0 ? C_POS : ice < 0 ? C_NEG : undefined }}>{iceTxt(r.target.ice)}</b>
              </button>
            );
          })}
          {zeroR.length > 0 && (
            <button type="button" onClick={() => setShowZero(!showZero)} className="flex w-full items-center gap-1.5 border-t border-border-seam pt-2 text-left text-[12px] text-muted-foreground hover:text-foreground">
              <Icon name={showZero ? "ChevronDown" : "ChevronRight"} className="size-3.5" /> {zeroR.length} с Impact 0
            </button>
          )}
          {showZero && zeroR.map((r) => (
            <button key={r.key} type="button" onClick={() => onPick(r.key)} className="block w-full truncate py-0.5 pl-5 text-left text-[12px] text-muted-foreground hover:text-foreground" title={r.name}>{r.name}</button>
          ))}
          <p className="mt-2 text-[11px] text-subtle-foreground">Jira прочитана {dmy(st.at)} {st.at.slice(11, 16)} UTC</p>
        </section>
      </div>
      <section className="rounded-xl border border-border px-4 pb-3 pt-3.5">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-[14px] font-semibold">Поля в Jira</h3>
          <span className="text-[11.5px] text-subtle-foreground">что сейчас в эпике и что запишем · синие — поля к записи</span>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[980px]">
            <div className={cn(cols, "border-b border-border-seam pb-1.5 pl-3 text-[11px] text-subtle-foreground")}>
              <span>Фича</span><span className="text-right">Impact, сом/мес</span><span className="text-right">Confidence</span><span className="text-right">Effort</span>
              <span className="text-right">ICE</span><span>В Jira сейчас: I · C · E · ICE</span><span>Запишем</span>
            </div>
            {est.map(tableRow)}
            {zeroR.length > 0 && (
              <button type="button" onClick={() => setShowZero(!showZero)} className="flex w-full items-center gap-1.5 border-t border-border-seam py-2 pl-3 text-left text-[12px] text-muted-foreground hover:text-foreground">
                <Icon name={showZero ? "ChevronDown" : "ChevronRight"} className="size-3.5" /> {zeroR.length} эпиков с Impact 0: запишем Impact 0 и Effort
              </button>
            )}
            {showZero && zeroR.map(tableRow)}
          </div>
        </div>
        {rows.some((r) => r.calc?.effort_split) && (
          <div className="mt-2 border-t border-border-seam pt-2 text-[12px]">
            <button type="button" onClick={() => setShowSplit(!showSplit)} className="flex items-center gap-1.5 font-medium hover:text-foreground">
              <Icon name={showSplit ? "ChevronDown" : "ChevronRight"} className="size-3.5" /> XL — предлагаю разбить: {rows.filter((r) => r.calc?.effort_split).length}
            </button>
            {showSplit && rows.filter((r) => r.calc?.effort_split).map((r) => (
              <div key={r.key} className="mt-1 pl-5 text-[11.5px] text-muted-foreground"><span className="text-foreground">{r.name}:</span> {r.calc.effort_split}</div>
            ))}
          </div>
        )}
      </section>
      <Block className="rounded-xl" title="Сверка после правки Effort" hint="разработчики меняют Effort в Jira — плагин пересчитывает ICE по их часам">
        <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
          <span>Будни в 10:15, после обновления «Релизов». Последняя: {st.sync ? `${dmy(st.sync.date)} · обновлено ${st.sync.changed?.length ?? 0}` : "ещё не было"}</span>
          <Button size="sm" variant="outline" onClick={sync}>Сверить сейчас</Button>
          {syncMsg && <span className="text-[11.5px] text-subtle-foreground">{syncMsg}</span>}
        </div>
        <p className="mt-2 text-[11.5px] text-subtle-foreground">Confidence: У1 100%, У2 80%, У3 50%, У4 30%, У5 20% — по главному входу ★. Effort ИИ: S 16 ч, M 40, L 80, XL 160 и больше. Запись — Jira API, правила Automation не запускаются.</p>
      </Block>
    </div>
  );
}

function CheatTab({ onOpen }: { onOpen: () => void }) {
  const ladder: [string, string, string, number][] = [
    ["У1", "Факт", "измерено в наших данных или задано в PRD", 8], ["У2", "Свой аналог", "похожее изменение на Mashina.kg", 26],
    ["У3", "Своя воронка", "размер проблемы известен, доля — нет", 50], ["У4", "Внешний бенчмарк", "эффект в похожих продуктах", 76],
    ["У5", "Экспертно", "суждение PO или ИИ, логика в одну строку", 100],
  ];
  const tbl = (head: string[], rows: string[][]) => (
    <table className="w-full text-[12px]">
      <thead><tr className="text-left text-[11px] text-subtle-foreground">{head.map((x) => <th key={x} className="py-1 pr-1 font-medium">{x}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r[0]} className="border-t border-border-seam">{r.map((c, i) => <td key={i} className={cn("py-1.5 pr-1", i === 2 && "bg-state-active font-semibold")}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
  const box = (title: ReactNode, sub: ReactNode, cls?: string) => (
    <div className={cn("rounded-lg border border-border bg-surface-recessed px-3 py-2", cls)}>{title}<div className="mt-0.5 text-[11px] text-subtle-foreground">{sub}</div></div>
  );
  return (
    <div>
      <section className="mb-4 rounded-xl border border-border px-4 py-3">
        <h3 className="text-[13.5px] font-semibold">Цвета панели</h3>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
          {([[C_POS, "плюс к выручке · высокая уверенность"], [C_NEG, "минус к выручке"], [C_ATT, "нужно решение · средняя уверенность · главный вход ★ · фича = 0"], [C_WARN, "низкая уверенность · проверки калькулятора"], [C_INFO, "сроки и Jira"], [C_AI, "ИИ: черновик, оценка, ревью"]] as [string, string][]).map(([c, t]) => (
            <span key={t} className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />{t}</span>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">{Object.keys(LINE_VAR).map((l) => <Pill key={l} c={lineColor(l)} dot>{l}</Pill>)}</div>
        <p className="mt-1.5 text-[11.5px] text-subtle-foreground">У каждой строки финотчёта свой цвет: полоса у фичи, столбики, карточки строк, точки на карте «Приоритетов» и в календаре замеров.</p>
      </section>
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
        <Block title="1. Лестница доказательств" hint="ниже уровень — шире вилка">
          {ladder.map(([k, n, dd, w]) => (
            <div key={k} className="flex items-center gap-2 border-t border-border-seam py-1.5">
              <b className="w-7 text-[13px]">{k}</b>
              <div className="w-44 shrink-0"><div className="text-[12.5px] font-semibold">{n}</div><div className="text-[10.5px] leading-tight text-subtle-foreground">{dd}</div></div>
              <div className="flex flex-1 justify-center"><i className="block h-2.5 rounded-full bg-foreground/25" style={{ width: `${w}%` }} /></div>
            </div>
          ))}
          <p className="mt-2 text-[11.5px] text-subtle-foreground">Уверенность фичи = уровень главного входа (сильнее всего двигает итог): высокая У1–У2, средняя У3, низкая У4–У5</p>
        </Block>
        <Block title="2. Три сценария">
          <div className="mb-3 grid grid-cols-[1fr_1.25fr_1fr] gap-1.5 text-center">
            {box(<b className="text-[12.5px]">Негативный</b>, "хуже — в 1 случае из 10")}
            {box(<b className="text-[12.5px]">Ожидаемый</b>, "среднее", "bg-state-active border-foreground/40")}
            {box(<b className="text-[12.5px]">Позитивный</b>, "лучше — в 1 случае из 10")}
          </div>
          {tbl(["Источник главного входа", "нег", "ожид", "поз"], [
            ["Факт (У1)", "факт", "факт", "факт"],
            ["Аналог (У2)", "худший или −50%", "аналог", "лучший или +50%"],
            ["Своя воронка (У3)", "0", "15% проблемы", "35%"],
            ["Бенчмарк, экспертно (У4–У5)", "0, расходы остаются", "осторожно", "если сработало"],
          ])}
          <p className="mt-2 text-[11.5px] text-subtle-foreground">Негатив и позитив фичи: каждый вход с вилкой отдельно из негатива или позитива, остальные ожидаемые; итог — ожидаемый ∓ корень из суммы квадратов сдвигов</p>
        </Block>
        <Block title="3. Типы фич">
          <div className="grid grid-cols-2 gap-2">
            {box(<span className="text-[13px]"><b className="mr-1.5 text-lg">A</b>Новая услуга</span>, "клиенты × конверсия × чек")}
            {box(<span className="text-[13px]"><b className="mr-1.5 text-lg">B</b>Рост существующей</span>, "база узла × сдвиг")}
            {box(<span className="text-[13px]"><b className="mr-1.5 text-lg">C</b>Через воронку</span>, "Δ единиц × деньги на единицу")}
            {box(<span className="text-[13px] text-subtle-foreground"><b className="mr-1.5 text-lg">D</b>Обеспечивающая</span>, "0 и список фич, которым помогает", "border-dashed bg-transparent")}
          </div>
          <p className="mt-2 text-[11.5px] text-subtle-foreground">C и D получают число, только если каждое звено до денег подтверждено данными</p>
        </Block>
        <Block title="4. Из числа фичи — в итог финотчёта">
          <Chain items={[
            { label: "Траты на услуги", value: "× k 84%" }, { arrow: "+" },
            { label: "Пополнения, первые покупки", value: "1 : 1" }, { arrow: "+" },
            { label: "Прямые: кредиты, лизинг, B2B", value: "1 : 1" }, { arrow: "=" },
            { label: "Итог финотчёта", value: "число к плану выручки", dark: true },
          ]} />
          <p className="mt-2 text-[11.5px] text-subtle-foreground">k = пополнения ÷ траты 4 услуг за 3 закрытых месяца (авг–окт 2026: 84%). Оплата бонусами — не выручка</p>
        </Block>
        <Block title="5. Итог релиза">
          <Chain items={[
            { label: "Простая сумма фич", value: "ожидаемый итог" }, { arrow: "корень из суммы квадратов отклонений" },
            { label: "Вилка релиза", value: "негатив и позитив" }, { arrow: "траты × k + пополнения + прямые" },
            { label: "Итог финотчёта", value: "к плану выручки" },
          ]} />
          <p className="mt-2 text-[11.5px] text-subtle-foreground">Фичи одной группы пересечений считаются одной единицей. Суммы крайних сценариев фич — не сценарий релиза</p>
        </Block>
        <Block title="6. Срок по статусу Jira" hint="оценка менее чем за 2 недели до релиза">
          {tbl(["Статус эпика", "поздний", "ожид", "поз"], [
            ["Готово к выпуску", "плановый", "плановый", "плановый"],
            ["Разработка", "следующий", "плановый", "плановый"],
            ["Готово к разработке … Системный анализ", "через релиз", "следующий", "плановый"],
            ["Бэклог дизайна, требования", "через два", "через релиз", "следующий"],
          ])}
          <p className="mt-2 text-[11.5px] text-subtle-foreground">Все сценарии эффекта — при ожидаемом сроке. Поздний срок — отдельный столбец</p>
        </Block>
      </div>
      <Block className="mt-4" title="7. Какое число брать">
        <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2 @6xl:grid-cols-4">
          {[["Приоритет в роадмапе", "Ожидаемый в месяц + уверенность"], ["Прогноз к плану выручки", "Итог финотчёта, ожидаемый; поздний срок — риск"],
            ["Запуск скидки или бонусов", "Ожидаемый против порога окупаемости"], ["План-факт по фиче", "Прямая метрика замера"]].map(([a, b]) => (
            <div key={a} className="rounded-lg border border-border px-3 py-2"><div className="text-[11.5px] text-muted-foreground">{a}</div><b className="text-[13px]">{b}</b></div>
          ))}
        </div>
      </Block>
      <div className="mt-3"><Button variant="ghost" size="sm" onClick={onOpen}><Icon name="FolderOpen" /> Открыть методику v3 целиком</Button></div>
    </div>
  );
}

// ---------- Панель ----------
// в шапке — 4 вкладки (редизайн 19.11); «Путь числа», «Проверки», «Шпаргалка» открываются поверх вкладки, адреса оставлены для старых ссылок
const NAV: { id: string; label: string }[] = [{ id: "release", label: "Релиз" }, { id: "whatif", label: "Рычаги" }, { id: "jira", label: "Приоритеты" }, { id: "measures", label: "Замеры" }];
const TABS: { id: string; label: string }[] = [{ id: "release", label: "Релиз" }, { id: "jira", label: "В Jira" }, { id: "path", label: "Путь числа" }, { id: "whatif", label: "Что если" }, { id: "checks", label: "Проверки" }, { id: "measures", label: "Замеры" }, { id: "cheat", label: "Шпаргалка" }];
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* нет доступа */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* нет доступа */ } },
};
// автосохранение правок входов и k: отдельно на каждый конфиг релиза, до «Сбросить»
const ovKey = (file: string) => `fr.ov.${file}`;
function readSaved(file: string): { ov: Inputs; k: number | null } {
  try {
    const s = JSON.parse(ls.get(ovKey(file)) ?? "null");
    if (s && typeof s === "object") return { ov: s.ov && typeof s.ov === "object" ? s.ov : {}, k: typeof s.k === "number" ? s.k : null };
  } catch { /* битая запись — начинаем с чистого */ }
  return { ov: {}, k: null };
}
// правки входов, которых больше нет в конфиге, отбрасываем: иначе калькулятор ругается
function pruneOv(o: Inputs, d: Data): Inputs {
  const ids = new Map<string, Set<string>>();
  const allIn = d?._meta?.all_inputs;
  if (allIn && typeof allIn === "object") {
    for (const [key, list] of Object.entries(allIn)) ids.set(key, new Set(list as string[]));
  } else {
    if (!Array.isArray(d._explain)) return o;
    for (const f of d._explain as Fx[]) ids.set(f.key, new Set(f.inputs.map((x: any) => x.id)));
  }
  let changed = false;
  const n: Inputs = {};
  for (const [key, f] of Object.entries(o)) {
    const ok = ids.get(key);
    const g: Record<string, number> = {};
    for (const [id, v] of Object.entries(f)) { if (ok?.has(id) && Number.isFinite(v)) g[id] = v; else changed = true; }
    if (Object.keys(g).length) n[key] = g; else if (Object.keys(f).length) changed = true;
  }
  return changed ? n : o;
}

function FeatureRevenuePanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [releases, setReleases] = useState<Rel[] | null>(null);
  const [selKey, setSelKey] = useState<string | null>(() => ls.get("fr.sel"));
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [h, setHState] = useState<H>(() => (ls.get("fr.h") as H) || "month");
  const [sel, setSel] = useState<string | null>(null);
  const [ov, setOv] = useState<Inputs>({});
  const [k, setK] = useState<number | null>(null);
  const [late, setLate] = useState(false);
  const [wi, setWi] = useState<WiState>({ data: null, busy: false, ms: null, error: null });
  const seq = useRef(0);
  const loadSeq = useRef(0);
  const ovFor = useRef<string | null>(null);
  const setH =(x: H) => { setHState(x); ls.set("fr.h", x); };
  const setInput = useCallback((key: string, id: string, v: number | null) => setOv((o) => {
    const f = { ...(o[key] ?? {}) };
    if (v == null) delete f[id]; else f[id] = v;
    const n = { ...o, [key]: f };
    if (!Object.keys(f).length) delete n[key];
    return n;
  }), []);
  const anyOv = Object.values(ov).some((x) => Object.keys(x).length);
  const clearOv = useCallback((key: string) => setOv((o) => { if (!o[key]) return o; const n = { ...o }; delete n[key]; return n; }), []);
  // «Путь числа» после правки входов: полный пересчёт калькулятора, пока он идёт — числа конфига
  const pathData = anyOv && wi.data?._explain ? wi.data : d;
  // «Релиз» и список фич: те же правки входов и k, что в карточке фичи и «Рычагах»
  const relData = wi.data?._explain ? wi.data : d;
  const nOvAll = Object.values(ov).reduce((s, x) => s + Object.keys(x).length, 0);
  const nOvFx = Object.values(ov).filter((x) => Object.keys(x).length).length;

  useEffect(() => {
    rpc.call("releases", {}).then((r) => {
      setReleases(r.list);
      setSelKey((x) => (x && r.list.some((y) => y.key === x) ? x : r.list[0]?.key ?? null));
    }, (e: unknown) => setError(errText(e)));
  }, [rpc]);
  const rel = releases?.find((r) => r.key === selKey);
  const file = rel?.file ?? null;
  const release = rel?.release ?? null;

  const load = useCallback((f: string, r: string | null) => {
    const my = ++loadSeq.current;
    setLoading(true);
    setError(null);
    rpc.call("load", { file: f, release: r }).then(
      (x) => { if (my === loadSeq.current) { setD(x.data); setLoading(false); } },
      (e: unknown) => { if (my === loadSeq.current) { setError(errText(e)); setLoading(false); } },
    );
  }, [rpc]);
  useEffect(() => {
    if (!file) return;
    if (selKey) ls.set("fr.sel", selKey);
    // другой релиз того же файла: правки входов остаются, они привязаны к фиче, а не к релизу
    if (ovFor.current !== file) {
      const saved = readSaved(file);
      ovFor.current = file;
      setOv(saved.ov); setK(saved.k);
    }
    setD(null); setSel(null); setWi({ data: null, busy: false, ms: null, error: null });
    load(file, release);
  }, [file, release, load]); // eslint-disable-line react-hooks/exhaustive-deps
  // конфиг загружен: убрать сохранённые правки входов, которых в нём больше нет
  useEffect(() => { if (d) setOv((o) => pruneOv(o, d)); }, [d]);
  // автосохранение: любая правка входа или k сразу пишется для текущего релиза
  useEffect(() => {
    const f = ovFor.current;
    if (!f) return;
    const empty = !Object.values(ov).some((x) => Object.keys(x).length) && k == null;
    if (empty) ls.del(ovKey(f)); else ls.set(ovKey(f), JSON.stringify({ ov, k, at: new Date().toISOString() }));
  }, [ov, k]);

  // что если: пересчёт тем же калькулятором с паузой 300 мс после последнего движения
  useEffect(() => {
    if (!file || !d) return;
    const empty = !Object.values(ov).some((x) => Object.keys(x).length) && k == null;
    if (empty) { setWi({ data: null, busy: false, ms: null, error: null }); return; }
    const my = ++seq.current;
    setWi((w) => ({ ...w, busy: true, error: null }));
    const t = setTimeout(() => {
      rpc.call("what_if", { file, release, inputs: ov, k }).then(
        (r) => { if (my === seq.current) setWi({ data: r.data, busy: false, ms: r.ms, error: null }); },
        (e: unknown) => { if (my === seq.current) setWi({ data: null, busy: false, ms: null, error: errText(e) }); },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [file, release, d, ov, k, rpc]);

  const tab = TABS.find((t) => t.id === subPath)?.id ?? "release";
  const go = (id: string) => nav.toPluginPanel(PANEL, { subPath: id });
  const empty = !!d && Array.isArray(d._explain) && d._explain.length === 0;
  const jr = (releases ?? []).filter((r) => r.group === "jira"), sn = (releases ?? []).filter((r) => r.group !== "jira");
  // карточка фичи поверх вкладки: ‹ › идут по списку, из которого её открыли
  const [sheet, setSheet] = useState<SheetState>(null);
  const liveKeys = useMemo(() => (Array.isArray(relData?._explain) ? (relData._explain as Fx[]).filter(nonzero).sort((a, b) => fval(b, "month", "exp") - fval(a, "month", "exp")).map((f) => f.key) : []), [relData]);
  const pick = (key: string, list?: string[], label?: string) => {
    const l = list && list.includes(key) ? list : liveKeys.includes(key) ? liveKeys : [key];
    setSel(key);
    setSheet({ kind: "fx", key, list: l, label: label ?? "Все фичи" });
  };
  useEffect(() => setSheet(null), [file, release]);
  // ближайшая дата замера — метка на вкладке «Замеры»
  const nextMeas = useMemo(() => {
    const at: string | undefined = d?._meta?.assessed?.slice(0, 10);
    let best: string | null = null;
    for (const m of (d?._measures ?? []) as any[]) for (const part of String(m.dates ?? "").split("/")) {
      const x = part.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!x) continue;
      const iso = `${x[3]}-${x[2]}-${x[1]}`;
      if (at && iso < at) continue;
      if (!best || iso < best) best = iso;
    }
    return best ? dm(best) : null;
  }, [d]);
  // ИИ: оценка фич релиза и ревью PO (review.tsx, ai.ts) — только конфиг всех фич, не снимки
  const reviewing = subPath === "review";
  const aiOn = rel?.group === "jira" && !!file && !!release;
  const reloadAll = useCallback(() => {
    rpc.call("releases", {}).then((r) => setReleases(r.list), () => { /* список обновится при следующем открытии */ });
    if (file) load(file, release);
  }, [rpc, file, release, load]);
  const ai = useAi(rpc, aiOn ? file : null, aiOn ? release : null, reviewing, reloadAll);
  const unestN = ((d?._meta?.pool_releases?.releases ?? []).find((r: any) => r.release === d?._meta?.release_filter)?.unestimated ?? []).length;
  const estN = Array.isArray(d?._explain) ? d._explain.length : 0;
  const openThread = (id: string) => nav.toThread(id, { split: true });
  if (reviewing && d && aiOn && file && release) return (
    <div className="fr-root flex h-full min-h-0 flex-col"><style>{FR_CSS}</style>
    <ReviewMode rpc={rpc} file={file} release={release} base={d} now={pathData} ov={ov} clearOv={clearOv} ai={ai} fetching={loading || wi.busy}
      renderFeature={(key) => <PathTab d={pathData} base={d} h="month" sel={key} onSel={() => { /* ревью: фичу выбирает полоса сверху */ }} ov={ov} setInput={setInput} onReset={() => setOv({})} wi={wi} single />}
      onExit={() => go("release")} onOpenThread={openThread} />
    </div>
  );

  return (
    <div className="fr-root relative flex h-full min-h-0 flex-col">
      <style>{FR_CSS}</style>
      <header className="shrink-0 border-b border-border-seam px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight">Выручка фич</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {d ? <>{d._meta.pool ? <>Jira на {jiraAt(d._meta.jira_at)}</> : <>Оценка на {dmy(d._meta.assessed)}</>} · методика v3 · тыс. сом</> : loading ? "Считаю релиз…" : "…"}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={selKey ?? ""} onChange={(e) => setSelKey(e.target.value)} aria-label="Релиз"
              className="rounded-md border border-border bg-transparent px-2 py-1 text-[13px] text-foreground outline-none focus:border-foreground/40">
              {jr.length > 0 && <optgroup label="По Jira: релиз и статус из Jira">{jr.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>}
              {sn.length > 0 && <optgroup label="Снимки: релиз и статус из файла">{sn.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</optgroup>}
            </select>
            {d && <Countdown d={d} />}
            {rel && rel.group !== "jira" && <Chip dashed>снимок · конфиг {rel.v3 ? "v3" : "v2"}</Chip>}
            <Seg value={h} onChange={setH} options={[{ v: "month", label: "В месяц" }, { v: "cy", label: String(d?._meta.cy ?? "год") }, { v: "ny", label: String(d?._meta.ny ?? "след. год") }]} />
            <Button variant="ghost" size="icon" onClick={() => setSheet({ kind: "cheat" })} aria-label="Методика: шпаргалка"><span className="text-[14px] font-bold">?</span></Button>
            <Button variant="ghost" size="icon" onClick={() => file && void rpc.call("open", { what: "config", file })} aria-label="Открыть конфиг релиза">
              <Icon name="FolderOpen" />
            </Button>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-end justify-between gap-x-5">
        <nav role="tablist" className="flex flex-wrap gap-x-6">
          {NAV.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}
              className={cn("-mb-px border-b-2 pb-2 pt-1.5 text-sm transition-colors", tab === t.id ? "font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              style={tab === t.id ? { borderImage: "linear-gradient(90deg, var(--fr-pop), var(--fr-promo)) 1" } : undefined}>
              {t.label}
              {t.id === "whatif" && anyOv && <span className="ml-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: C_ATT }} title="Есть изменённые входы" />}
              {t.id === "measures" && nextMeas && <span className="ml-1.5 rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums" style={{ background: tint(C_AI, 22), color: C_AI }} title="Ближайшая дата замера">{nextMeas}</span>}
            </button>
          ))}
        </nav>
        {aiOn && file && release && <AiActions rpc={rpc} file={file} release={release} ai={ai} unest={unestN} estimated={estN} onReview={() => go("review")} onOpenThread={openThread} />}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[1320px] px-5 py-5">
          {error && <div className="mb-4"><Note><span className="text-destructive-text">{error}</span></Note></div>}
          {!d && !error && tab !== "cheat" && <p className="text-sm text-muted-foreground">{loading ? "Считаю релиз калькулятором… первый запуск — до 10 секунд" : "Выберите релиз"}</p>}
          {d && rel && !rel.v3 && tab !== "cheat" && (
            <div className="mb-4"><Note>Конфиг релиза собран до методики v3: не указано, какие это деньги, нет метрик замера и итога финотчёта. Числа считает калькулятор v3 (решение PO 17.11: релиз 25.11 не пересчитывать).</Note></div>
          )}
          {d && rel?.group === "snap" && /^\d{4}-/.test(rel.file) && tab !== "cheat" && (
            <div className="mb-4"><Note>Снимок оценки: релиз и статус фич — из файла на дату оценки, переносы в Jira не учтены. Актуальные числа — пункты «Релиз …» в группе «По Jira».</Note></div>
          )}
          {d && tab === "release" && (nOvAll > 0 || k != null) && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-[12.5px]">
              <span style={{ color: C_ATT }}>{wi.error ? <span className="text-destructive-text">Ошибка пересчёта: {wi.error}. Показаны исходные числа</span> : wi.busy ? "Пересчитываю с вашими правками…" : `Числа с вашими правками: входов ${nOvAll}${nOvFx ? ` в ${nOvFx} фич.` : ""}${k != null ? " · k изменён" : ""}`}</span>
              <span className="text-subtle-foreground">конфиг и xlsx не меняются</span>
              <Button className="ml-auto" variant="outline" size="sm" onClick={() => { setOv({}); setK(null); }}><Icon name="RotateCcw" /> Сбросить всё</Button>
            </div>
          )}
          {d && relData && tab === "release" && <ReleaseTab key={selKey ?? ""} d={relData} h={h} onPick={pick} onOpenChecks={() => setSheet({ kind: "checks" })} />}
          {d && empty && (tab === "path" || tab === "whatif") && <Note>В релизе нет оценённых фич: считать нечего. Список эпиков без оценки — на вкладке «Релиз».</Note>}
          {d && !empty && tab === "path" && <PathTab d={pathData} base={d} h={h} sel={sel} onSel={setSel} ov={ov} setInput={setInput} onReset={() => setOv({})} wi={wi} />}
          {d && !empty && tab === "whatif" && <WhatIfTab d={d} h={h} setH={setH} ov={ov} setOv={setOv} setInput={setInput} k={k} setK={setK} late={late} setLate={setLate} wi={wi} onPick={pick} />}
          {d && tab === "jira" && <JiraTab key={selKey ?? ""} d={d} file={file} release={release} isPool={!!d._meta.pool} onPick={pick} />}
          {d && tab === "measures" && <MeasuresTab key={selKey ?? ""} d={d} onPick={pick} file={file} onSaved={reloadAll} />}
          {d && tab === "checks" && <ChecksTab key={selKey ?? ""} d={d} onPick={pick} />}
          {tab === "cheat" && <CheatTab onOpen={() => void rpc.call("open", { what: "method" })} />}
        </div>
      </main>
      {sheet?.kind === "fx" && d && (() => {
        const i = sheet.list.indexOf(sheet.key);
        const nameOf = (x: string) => ((d._explain ?? []) as Fx[]).find((f) => f.key === x)?.name ?? x;
        const to = (j: number) => { const x = sheet.list[j]; if (x) { setSel(x); setSheet({ ...sheet, key: x }); } };
        return (
          <Sheet onClose={() => setSheet(null)} scrollKey={sheet.key}
            head={<>
              <Button variant="outline" size="icon" disabled={i <= 0} onClick={() => to(i - 1)} aria-label="Предыдущая фича"><Icon name="ChevronLeft" /></Button>
              <Button variant="outline" size="icon" disabled={i < 0 || i >= sheet.list.length - 1} onClick={() => to(i + 1)} aria-label="Следующая фича"><Icon name="ChevronRight" /></Button>
              <span className="ml-1 text-[12px] text-muted-foreground">{sheet.label} · <b className="text-foreground">{i + 1} из {sheet.list.length}</b></span>
            </>}
            foot={<>
              <Button variant="outline" size="sm" disabled={i <= 0} onClick={() => to(i - 1)}><Icon name="ChevronLeft" /> Предыдущая</Button>
              <span className="min-w-0 flex-1 truncate text-center text-[11.5px] text-subtle-foreground">{anyOv ? "Правки входов сохраняются сами · итог релиза пересчитан" : "Число во входе можно поменять — всё пересчитается"}</span>
              {i >= 0 && i < sheet.list.length - 1
                ? <Button size="sm" onClick={() => to(i + 1)}><span className="max-w-[280px] truncate">Следующая: {nameOf(sheet.list[i + 1])}</span><Icon name="ChevronRight" /></Button>
                : <Button variant="outline" size="sm" onClick={() => setSheet(null)}>Готово</Button>}
            </>}>
            <PathTab d={pathData} base={d} h={h} sel={sheet.key} onSel={() => { /* фичу выбирают ‹ › */ }} ov={ov} setInput={setInput} onReset={() => setOv({})} wi={wi} single />
          </Sheet>
        );
      })()}
      {sheet?.kind === "checks" && d && <Sheet title="Проверки калькулятора" onClose={() => setSheet(null)}><ChecksTab d={d} onPick={pick} /></Sheet>}
      {sheet?.kind === "cheat" && <Sheet title="Методика: шпаргалка" onClose={() => setSheet(null)}><CheatTab onOpen={() => void rpc.call("open", { what: "method" })} /></Sheet>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL,
    title: "Выручка фич",
    icon: "Calculator",
    path: PANEL,
    component: FeatureRevenuePanel,
  });
});
