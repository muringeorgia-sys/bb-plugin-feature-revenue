// Выручка фич — панель методики оценки выручки фич Mashina.kg.
// Все числа считает калькулятор проекта 03_scripts/stable/feature_revenue/build.py в режиме --serve:
// один процесс python на всё время работы панели, запросы и ответы — строками JSON.
// Процесс перезапускается сам, если build.py изменился. Конфиги — releases/*.json: features.json — все фичи,
// релиз и статус из Jira (решение PO 18.11.2026); ГГГГ-ММ-ДД.json — снимки оценки одного релиза.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { aiContract, aiHandlers } from "./ai";

// ---------- Jira: поля ICE в эпике (решение PO 18.11.2026). Токен — переменные пользователя Windows, как у «Релизов» ----------
const envCache: Record<string, string> = {};
function userEnv(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  if (envCache[name] !== undefined) return envCache[name];
  let v = "";
  try {
    v = execFileSync("powershell.exe", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch { v = ""; }
  return (envCache[name] = v);
}
async function jira(site: string, method: string, p: string, body?: unknown): Promise<any> {
  const e = userEnv("ATLASSIAN_EMAIL"), t = userEnv("ATLASSIAN_API_TOKEN");
  if (!e || !t) throw new Error("Нет ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN в переменных пользователя Windows");
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(site + p, {
      method,
      headers: { Authorization: "Basic " + Buffer.from(`${e}:${t}`).toString("base64"), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && attempt < 4) { await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`Jira ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
}
type IceFields = { impact: string; confidence: string; effort: string; ice: string };
type IceVals = { impact: number | null; confidence: number | null; effort: number | null; ice: number | null };
function jiraConf(releasesDir: string, file: string): { site: string; fields: IceFields } {
  const cfg = JSON.parse(readFileSync(path.join(releasesDir, file), "utf8"));
  const j = cfg.jira ?? {};
  if (!j.fields?.ice) throw new Error("В конфиге нет jira.fields: запись ICE работает только из features.json");
  if (!j.site) throw new Error("В конфиге нет адреса Jira (jira.site)");
  return { site: j.site, fields: j.fields };
}
async function readIce(site: string, fields: IceFields, keys: string[]): Promise<Record<string, IceVals & { summary: string }>> {
  const out: Record<string, IceVals & { summary: string }> = {};
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    const r = await jira(site, "POST", "/rest/api/3/search/jql", { jql: `key in (${part.join(",")})`, maxResults: 100, fields: ["summary", fields.impact, fields.confidence, fields.effort, fields.ice] });
    for (const it of r.issues ?? []) {
      const f = it.fields ?? {};
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      out[it.key] = { summary: f.summary ?? "", impact: num(f[fields.impact]), confidence: num(f[fields.confidence]), effort: num(f[fields.effort]), ice: num(f[fields.ice]) };
    }
  }
  return out;
}
const iceOf = (impact: number | null, conf: number | null, effort: number | null): number | null => {
  if (impact == null || !effort) return null;
  if (impact === 0) return 0;
  if (conf == null) return null;
  return Math.round((impact * conf) / 100 / effort);
};
// что писать в эпик: Impact и Confidence — из расчёта; Effort — только в пустое поле; ICE — по Effort, который будет в Jira
function icePlan(calc: any, cur: IceVals | undefined) {
  const effortUse = cur?.effort ?? calc?.effort_hours ?? null;
  const target: IceVals = { impact: calc?.impact ?? null, confidence: calc?.confidence ?? null, effort: effortUse, ice: iceOf(calc?.impact ?? null, calc?.confidence ?? null, effortUse) };
  const write: Partial<IceVals> = {};
  if (target.impact != null && target.impact !== cur?.impact) write.impact = target.impact;
  if (target.confidence != null && target.confidence !== cur?.confidence) write.confidence = target.confidence;
  if (cur?.effort == null && calc?.effort_hours) write.effort = calc.effort_hours;
  if (target.ice != null && target.ice !== cur?.ice) write.ice = target.ice;
  return { target, write, effortFrom: cur?.effort != null ? "Jira" : calc?.effort_hours ? "ИИ" : null };
}
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

class Calc {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private mtime = 0;
  private buf = "";
  private err: string[] = [];
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(
    private buildPath: string,
    private python: string,
    private log: (m: string) => void,
  ) {}

  private ensure() {
    const m = statSync(this.buildPath).mtimeMs;
    if (this.proc && this.proc.exitCode === null && this.mtime === m) return;
    this.stop("калькулятор перезапущен");
    this.mtime = m;
    this.buf = "";
    this.err = [];
    const p = spawn(this.python, [this.buildPath, "--serve"], {
      cwd: path.dirname(this.buildPath),
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line) as { id: number; ok: boolean; data?: unknown; error?: string };
          const w = this.pending.get(r.id);
          if (!w) continue;
          this.pending.delete(r.id);
          clearTimeout(w.timer);
          if (r.ok) w.resolve(r.data);
          else w.reject(new Error(r.error ?? "ошибка калькулятора"));
        } catch (e) {
          this.log(`не разобран ответ калькулятора: ${line.slice(0, 200)}`);
        }
      }
    });
    p.stderr.on("data", (chunk: string) => {
      this.err.push(chunk);
      if (this.err.length > 40) this.err.shift();
    });
    p.on("exit", (code) => {
      const tail = this.err.join("").trim().split("\n").slice(-4).join(" ");
      if (this.proc === p) this.proc = null;
      for (const [id, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new Error(`калькулятор остановился (код ${code})${tail ? ": " + tail : ""}`));
        this.pending.delete(id);
      }
    });
    p.on("error", (e) => this.log(`не запустился python: ${e.message}`));
    this.proc = p;
  }

  ask(req: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("калькулятор не ответил за 60 с"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, ...req }) + "\n");
    });
  }

  stop(reason = "панель закрыта") {
    if (!this.proc) return;
    for (const [id, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
      this.pending.delete(id);
    }
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      /* процесс уже завершился */
    }
    this.proc = null;
  }
}

// Пункт выбора в панели. Конфиг со всеми фичами (поле jira) даёт по пункту на релиз Jira: релиз — фильтр.
// Конфиги одного релиза (releases/ГГГГ-ММ-ДД.json) — снимки оценки, релиз и статус в них из файла.
type ReleaseInfo = {
  key: string; file: string; release: string | null; group: "jira" | "snap"; label: string; name: string;
  v3: boolean; features: number; planned: string | null;
};
type PoolList = { releases: { release: string; estimated: number; with_number: number; unestimated: unknown[] }[]; no_release: string[]; features: number } | null;

const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

async function listReleases(releasesDir: string, calc: Calc, log: (m: string) => void): Promise<ReleaseInfo[]> {
  const jira: ReleaseInfo[] = [];
  const snaps: ReleaseInfo[] = [];
  for (const file of readdirSync(releasesDir).filter((f) => f.endsWith(".json"))) {
    let cfg: any;
    try {
      cfg = JSON.parse(readFileSync(path.join(releasesDir, file), "utf8"));
    } catch {
      snaps.push({ key: `${file}|`, file, release: null, group: "snap", label: `${file} · не читается`, name: file, v3: false, features: 0, planned: null });
      continue;
    }
    const feats: any[] = cfg.features ?? [];
    const v3 = !!cfg.lines || !!cfg.fin_total || feats.some((f) => (f.components ?? []).some((c: any) => "mechanic" in c || "line" in c));
    const name = cfg.release?.name ?? file;
    if (cfg.jira) {
      let pl: PoolList = null;
      try {
        pl = (await calc.ask({ config: path.join(releasesDir, file), list: true })) as PoolList;
      } catch (e) {
        log(`список релизов ${file}: ${(e as Error).message}`);
      }
      for (const r of pl?.releases ?? []) {
        const n = r.estimated, u = r.unestimated.length;
        const label = `Релиз ${ddmm(r.release)} · ${n ? `${n} ${plural(n, "фича", "фичи", "фич")}` : "нет оценок"}${u ? `, без оценки ${u}` : ""}`;
        jira.push({ key: `${file}|${r.release}`, file, release: r.release, group: "jira", label, name, v3, features: n, planned: r.release });
      }
      if (pl?.no_release?.length) jira.push({ key: `${file}|none`, file, release: "none", group: "jira", label: `Без релиза в Jira · ${pl.no_release.length}`, name, v3, features: pl.no_release.length, planned: null });
      jira.push({ key: `${file}|all`, file, release: "all", group: "jira", label: `Все оценённые фичи · ${feats.length}`, name, v3, features: feats.length, planned: null });
      continue;
    }
    const planned: string | null = cfg.release?.planned ?? (Object.values(cfg.release?.dates ?? {}).sort()[0] as string | undefined) ?? null;
    const m = file.match(/^(\d{4})-(\d{2})-(\d{2})\.json$/);
    const label = m ? `Снимок ${m[3]}.${m[2]} · оценка ${cfg.release?.assessed ? ddmm(cfg.release.assessed) : "—"}` : file === "template.json" ? "Шаблон v3 · пример" : file.replace(/\.json$/, "");
    snaps.push({ key: `${file}|`, file, release: null, group: "snap", label, name, v3, features: feats.length, planned });
  }
  // снимки: свежие сверху, шаблон и прочее — в конце
  snaps.sort((x, y) => {
    const dx = /^\d{4}-/.test(x.file), dy = /^\d{4}-/.test(y.file);
    if (dx !== dy) return dx ? -1 : 1;
    return y.file.localeCompare(x.file);
  });
  return [...jira, ...snaps];
}

const fileSchema = z.string().regex(/^[\w.\-]+\.json$/);
const inputsSchema = z.record(z.string(), z.record(z.string(), z.number()));
const okSchema = z.object({ ok: z.boolean(), message: z.string().optional() });
const releaseSchema = z.string().regex(/^(\d{4}-\d{2}-\d{2}|all|none)$/).nullable().optional();
const relItem = z.object({
  key: z.string(), file: z.string(), release: z.string().nullable(), group: z.enum(["jira", "snap"]), label: z.string(),
  name: z.string(), v3: z.boolean(), features: z.number(), planned: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  releases: {
    input: z.object({}),
    output: z.object({ list: z.array(relItem) }),
  },
  load: { input: z.object({ file: fileSchema, release: releaseSchema }), output: z.object({ data: z.unknown(), ms: z.number() }) },
  what_if: {
    input: z.object({ file: fileSchema, release: releaseSchema, inputs: inputsSchema, k: z.number().nullable() }),
    output: z.object({ data: z.unknown(), ms: z.number() }),
  },
  open: { input: z.object({ what: z.enum(["method", "config", "folder"]), file: fileSchema.optional() }), output: okSchema },
  jira_state: { input: z.object({ file: fileSchema, release: releaseSchema }), output: z.object({ rows: z.array(z.unknown()), at: z.string(), sync: z.unknown() }) },
  jira_write: {
    input: z.object({ file: fileSchema, release: releaseSchema, keys: z.array(z.string().regex(/^PRODUCT-\d+$/)) }),
    output: z.object({ results: z.array(z.object({ key: z.string(), ok: z.boolean(), written: z.unknown(), error: z.string().optional() })) }),
  },
  jira_sync: { input: z.object({}), output: z.object({ ok: z.boolean(), changed: z.array(z.string()), message: z.string() }) },
  // факт замера: дописать или убрать {date, value} в measure.facts фичи (редизайн 19.11.2026, вкладка «Замеры»)
  measure_fact: {
    input: z.object({ file: fileSchema, key: z.string().regex(/^PRODUCT-\d+$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), value: z.number().nullable() }),
    output: okSchema,
  },
  ...aiContract,
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    projectRoot: { type: "string", label: "Папка проекта Mashina.kg", default: "" },
    python: { type: "string", label: "Команда или абсолютный путь к Python", default: "python" },
    projectId: { type: "string", label: "ID проекта BB для задач ИИ", default: "" },
    environmentId: { type: "string", label: "ID среды BB для задач ИИ", default: "" },
  });
  const { projectRoot, python, projectId, environmentId } = await settings.get();
  const calcDir = path.join(projectRoot, "03_scripts", "stable", "feature_revenue");
  const buildPath = path.join(calcDir, "build.py");
  const releasesDir = path.join(calcDir, "releases");
  if (!path.isAbsolute(projectRoot) || !existsSync(buildPath) || !existsSync(releasesDir)) {
    bb.status.needsConfiguration("Укажите абсолютный путь к проекту Mashina.kg с калькулятором и конфигами релизов.");
    return;
  }
  const methodPath = path.join(projectRoot, "_БАЗА", "Методика_Оценка-выручки-фич.md");
  // Смена данных плагина «Релизы» сбрасывает кэш расчётов.
  const jiraData = path.join(projectRoot, "04_outputs", "final", "release-dashboard", "data.json");
  const iceDir = path.join(projectRoot, "04_outputs", "final", "feature-revenue");
  const iceLogPath = path.join(iceDir, "jira_ice_log.jsonl");
  const iceState = path.join(iceDir, "jira_ice_state.json");
  const iceLog = (entry: Record<string, unknown>) => {
    mkdirSync(iceDir, { recursive: true });
    appendFileSync(iceLogPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  };

  const calc = new Calc(buildPath, python, (m) => bb.log.error(m));
  bb.onDispose(() => calc.stop());
  const cache = new Map<string, unknown>();
  const cfgPath = (file: string) => {
    const p = path.join(releasesDir, file);
    if (!existsSync(p)) throw new Error(`нет конфига ${file}`);
    return p;
  };

  // данные релиза для ICE: тот же расчёт, что у «Релиза» (без правок «Что если»)
  const loadData = async (file: string, release: string | null | undefined): Promise<any> => {
    const p = cfgPath(file);
    const jm = existsSync(jiraData) ? statSync(jiraData).mtimeMs : 0;
    const key = `${file}:${release ?? ""}:${statSync(p).mtimeMs}:${statSync(buildPath).mtimeMs}:${jm}`;
    if (!cache.has(key)) cache.set(key, await calc.ask({ config: p, release: release ?? null }));
    return cache.get(key);
  };
  const readState = (): any => { try { return JSON.parse(readFileSync(iceState, "utf8")); } catch { return {}; } };
  // ежедневная сверка: разработчики поменяли Effort в Jira → переписать только ICE по полям Jira
  const syncIce = async (by: string) => {
    const file = "features.json";
    const { site, fields } = jiraConf(releasesDir, file);
    const cfg = JSON.parse(readFileSync(path.join(releasesDir, file), "utf8"));
    const keys: string[] = (cfg.features ?? []).map((f: any) => f.key);
    const cur = await readIce(site, fields, keys);
    const changed: string[] = [];
    for (const k of keys) {
      const c = cur[k];
      if (!c || c.impact == null || c.effort == null) continue;
      const ice = iceOf(c.impact, c.confidence, c.effort);
      if (ice == null || ice === c.ice) continue;
      await jira(site, "PUT", `/rest/api/3/issue/${encodeURIComponent(k)}`, { fields: { [fields.ice]: ice } });
      iceLog({ by, key: k, write: { ice }, was: c.ice, effort: c.effort });
      changed.push(k);
    }
    const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
    mkdirSync(iceDir, { recursive: true });
    writeFileSync(iceState, JSON.stringify({ ...readState(), lastSync: { date: today, at: new Date().toISOString(), by, changed } }, null, 1), "utf8");
    return changed;
  };
  const dailyIce = async (by: string) => {
    const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
    if (readState().lastSync?.date === today) return;
    try { const ch = await syncIce(by); bb.log.info(`сверка ICE (${by}): обновлено ${ch.length}`); } catch (e) { bb.log.error(`сверка ICE: ${(e as Error).message}`); }
  };

  bb.rpc.register(rpcContract, {
    // ИИ: оценка фич релиза и ревью PO (ai.ts)
    ...aiHandlers(bb, {
      root: projectRoot,
      releasesDir,
      projectId,
      environmentId,
      pool: (file) => calc.ask({ config: cfgPath(file), list: true }),
      data: (file, release) => loadData(file, release),
    }),
    jira_state: async ({ file, release }) => {
      const { site, fields } = jiraConf(releasesDir, file);
      const data = await loadData(file, release);
      const keys: string[] = (data._explain ?? []).map((f: any) => f.key);
      const cur = await readIce(site, fields, keys);
      const rows = (data._explain ?? []).map((f: any) => {
        const calcV = data._ice?.[f.key] ?? null;
        const plan = icePlan(calcV, cur[f.key]);
        return { key: f.key, name: f.name, calc: calcV, jira: cur[f.key] ?? null, ...plan };
      });
      return { rows, at: new Date().toISOString(), sync: readState().lastSync ?? null };
    },
    jira_write: async ({ file, release, keys }) => {
      const { site, fields } = jiraConf(releasesDir, file);
      const data = await loadData(file, release);
      const cur = await readIce(site, fields, keys);
      const results: { key: string; ok: boolean; written: unknown; error?: string }[] = [];
      for (const k of keys) {
        const plan = icePlan(data._ice?.[k], cur[k]);
        const body: Record<string, number> = {};
        for (const [name, v] of Object.entries(plan.write)) if (typeof v === "number") body[fields[name as keyof IceFields]] = v;
        if (!Object.keys(body).length) { results.push({ key: k, ok: true, written: {} }); continue; }
        try {
          await jira(site, "PUT", `/rest/api/3/issue/${encodeURIComponent(k)}`, { fields: body });
          iceLog({ by: "кнопка PO", key: k, write: plan.write, was: cur[k] ?? null });
          results.push({ key: k, ok: true, written: plan.write });
        } catch (e) {
          results.push({ key: k, ok: false, written: {}, error: (e as Error).message });
        }
      }
      return { results };
    },
    jira_sync: async () => {
      try { const ch = await syncIce("кнопка «Сверить сейчас»"); return { ok: true, changed: ch, message: ch.length ? `ICE обновлён: ${ch.join(", ")}` : "Effort в Jira не менялся: ICE совпадает" }; }
      catch (e) { return { ok: false, changed: [], message: (e as Error).message }; }
    },
    releases: async () => ({ list: await listReleases(releasesDir, calc, (m) => bb.log.error(m)) }),
    load: async ({ file, release }) => {
      const p = cfgPath(file);
      const jm = existsSync(jiraData) ? statSync(jiraData).mtimeMs : 0;
      const key = `${file}:${release ?? ""}:${statSync(p).mtimeMs}:${statSync(buildPath).mtimeMs}:${jm}`;
      const t = Date.now();
      if (!cache.has(key)) {
        cache.set(key, await calc.ask({ config: p, release: release ?? null }));
        bb.log.info(`load ${file} ${release ?? ""}: ${Date.now() - t} мс`);
      }
      return { data: cache.get(key), ms: Date.now() - t };
    },
    what_if: async ({ file, release, inputs, k }) => {
      const t = Date.now();
      // полный ответ с шагами (_explain): вкладка «Путь числа» показывает пересчёт входов целиком (~120 КБ на релиз 25.11)
      const data = await calc.ask({ config: cfgPath(file), release: release ?? null, overrides: { inputs, k } });
      return { data, ms: Date.now() - t };
    },
    measure_fact: async ({ file, key, date, value }) => {
      try {
        execFileSync(python, [path.join(calcDir, "measure_fact.py"), cfgPath(file), key, date, value == null ? "" : String(value)], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).trim().split(/\r?\n/).pop() || "ошибка записи";
        return { ok: false, message: msg };
      }
      bb.log.info(`факт замера ${key} ${date}: ${value ?? "убран"}`);
      return { ok: true };
    },
    open: async ({ what, file }) => {
      const target = what === "method" ? methodPath : what === "config" && file ? cfgPath(file) : calcDir;
      spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return { ok: true };
    },
  });

  // прогрев: импорт openpyxl идёт несколько секунд, делаем его до первого открытия панели
  const warm = setTimeout(() => {
    const files = readdirSync(releasesDir).filter((f) => f.endsWith(".json"));
    const first = files.includes("features.json") ? "features.json" : files[0];
    if (first) calc.ask({ config: path.join(releasesDir, first), slim: true }).catch((e) => bb.log.error(`прогрев: ${e.message}`));
  }, 5_000);
  bb.onDispose(() => clearTimeout(warm));

  // сверка ICE: будни 10:15 (после обновления «Релизов» в 10:00) и догон при запуске bb в будни 10:00–18:00, раз в день
  bb.background.schedule("ice-sync-1015", "15 10 * * 1-5", () => dailyIce("расписание 10:15"));
  const iceT = setTimeout(() => {
    const d = new Date(Date.now() + 6 * 3600e3), day = d.getUTCDay(), hour = d.getUTCHours();
    if (day >= 1 && day <= 5 && hour >= 10 && hour < 18) void dailyIce("запуск bb после 10:15");
  }, 120_000);
  bb.onDispose(() => clearTimeout(iceT));
}
