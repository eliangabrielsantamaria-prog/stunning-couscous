// The Garden House Boquete - servidor de guardado (Netlify Functions + Netlify Blobs)
// Guarda la base de datos completa como "revisiones" numeradas. Nada se sobrescribe:
// cada guardado crea una revisión nueva (se conservan las últimas 60) y hay una copia diaria (60 días).
// Acceso protegido por la clave GH_ACCESS_KEY (variable de entorno en Netlify).
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const KEEP_REVS = 60;
const KEEP_DAYS = 60;
const MAX_BYTES = 5_500_000; // las funciones de Netlify aceptan ~6 MB por petición
const pad = (n) => String(n).padStart(9, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const panamaDay = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function keyMatches(got, expected) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHandler(store, opts = {}) {
  const getKey = opts.getKey || (() => process.env.GH_ACCESS_KEY);
  const day = opts.day || panamaDay;
  const delay = opts.delay ?? 400;

  async function headRev() {
    let n = Number(await store.get("head")) || 0;
    // si el puntero quedó atrasado (corte justo entre dos escrituras), avanza hasta la última revisión real
    while (await store.getMetadata("rev/" + pad(n + 1))) n++;
    return n;
  }
  async function readRev(n) {
    if (!n) return null;
    const t = await store.get("rev/" + pad(n));
    return t ? JSON.parse(t) : null;
  }

  return async function handle(req) {
    const key = getKey();
    if (!key || key.length < 8) {
      return json({ error: "config", message: "Falta la variable GH_ACCESS_KEY (mínimo 8 caracteres) en Netlify." }, 500);
    }
    if (!keyMatches(req.headers.get("x-access-key"), key)) {
      await sleep(delay); // frena intentos automáticos
      return json({ error: "auth", message: "Clave de acceso incorrecta." }, 401);
    }
    const url = new URL(req.url);

    if (req.method === "GET") {
      if (url.searchParams.has("list")) {
        const { blobs } = await store.list({ prefix: "daily/" });
        return json({ days: blobs.map((b) => b.key.slice(6)).sort().reverse() });
      }
      if (url.searchParams.has("daily")) {
        const d = url.searchParams.get("daily");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "bad" }, 400);
        const t = await store.get("daily/" + d);
        return t ? json({ db: JSON.parse(t) }) : json({ error: "notfound" }, 404);
      }
      const head = await headRev();
      if (head === 0) return json({ rev: 0, db: null });
      if (Number(url.searchParams.get("rev")) === head) return json({ rev: head, same: true });
      return json({ rev: head, db: await readRev(head) });
    }

    if (req.method === "PUT") {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json({ error: "size", message: "La base de datos es demasiado grande para guardar. Descarga un respaldo y limpia registros viejos." }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: "bad" }, 400); }
      if (!body || typeof body.db !== "object" || body.db === null || Array.isArray(body.db)) return json({ error: "bad" }, 400);

      const head = await headRev();
      const conflict = async () => {
        const h = await headRev();
        return json({ error: "conflict", rev: h, db: await readRev(h) }, 409);
      };
      if (Number(body.baseRev) !== head) return conflict();

      const next = head + 1;
      const data = JSON.stringify(body.db);
      const res = await store.set("rev/" + pad(next), data, { onlyIfNew: true });
      if (!res.modified) return conflict(); // otro equipo ganó esta revisión al mismo tiempo
      await store.set("head", String(next));

      // copia diaria (se refresca cada 30 min como máximo)
      const dkey = "daily/" + day();
      const meta = await store.getMetadata(dkey);
      const isNewDay = !meta;
      if (isNewDay || Date.now() - Number(meta.metadata?.ts || 0) > 30 * 60e3) {
        await store.set(dkey, data, { metadata: { ts: Date.now() } });
      }
      // limpieza de revisiones y días antiguos
      if (next > KEEP_REVS) { try { await store.delete("rev/" + pad(next - KEEP_REVS)); } catch {} }
      if (isNewDay) {
        try {
          const { blobs } = await store.list({ prefix: "daily/" });
          const keys = blobs.map((b) => b.key).sort();
          for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) await store.delete(k);
        } catch {}
      }
      return json({ rev: next });
    }

    return json({ error: "method" }, 405);
  };
}

export default async (req) => {
  const store = getStore({ name: "garden-house", consistency: "strong" });
  return createHandler(store)(req);
};

export const config = { path: "/api" };
