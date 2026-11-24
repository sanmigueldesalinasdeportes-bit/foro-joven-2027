// Foro Joven 2027 · API (Netlify Functions + Netlify Blobs)
// Rutas públicas:  GET /api/estado · GET /api/me · POST /api/idea
// Rutas admin (cabecera x-admin-pin = variable de entorno ADMIN_PIN):
//   POST /api/admin/login · GET /api/admin/all · POST /api/admin/borrador
//   POST /api/admin/estado · POST /api/admin/delete-idea
import { getStore } from "@netlify/blobs";

const CATS = ["talleres", "excursiones", "viajes", "charlas", "ocio", "otros"];
const MAX_IDEAS = 30;
const TOTAL = 9;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const cleanLong = (v, n) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);

async function hash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

const winner = (w) => ({
  uid: clean(w?.uid, 40),
  alias: clean(w?.alias, 30),
  titulo: clean(w?.titulo, 90),
  cat: CATS.includes(w?.cat) ? w.cat : "otros",
  ideaId: clean(w?.ideaId, 40),
  modo: w?.modo === "propuesta" ? "propuesta" : "sorteo",
  tickets: Number.isFinite(w?.tickets) ? w.tickets : undefined,
});

function adminPin() {
  try { if (globalThis.Netlify?.env) return Netlify.env.get("ADMIN_PIN") || ""; } catch {}
  return process.env.ADMIN_PIN || "";
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, "").replace(/\/$/, "");
  const POST = req.method === "POST";
  const body = POST ? await req.json().catch(() => ({})) : {};
  const store = getStore({ name: "foro-joven-2027", consistency: "strong" });
  const getEstado = async () => (await store.get("estado", { type: "json" })) || {};

  try {
    // ---------- público ----------
    if (path === "estado" && !POST) {
      const e = await getEstado();
      return json({
        cerrado: !!e.cerrado,
        publicado: !!e.publicado,
        ganadores: e.publicado ? (e.ganadores || []).map(({ uid, alias, titulo, cat, modo }) => ({ uid, alias, titulo, cat, modo })) : [],
        suplentes: e.publicado ? (e.suplentes || []).map(({ uid, alias }) => ({ uid, alias })) : [],
        publicadoEn: e.publicado ? e.publicadoEn || null : null,
      });
    }

    if (path === "me" || path === "idea") {
      const token = req.headers.get("x-token") || "";
      if (token.length < 20 || token.length > 128) return json({ error: "token" }, 400);
      const uid = await hash(token);
      const key = "p/" + uid;
      const mine = await store.get(key, { type: "json" });
      if (path === "me") return json({ uid, mine: mine || null });
      if (!POST) return json({ error: "method" }, 405);

      const e = await getEstado();
      if (e.cerrado) return json({ error: "cerrado" }, 403);
      const alias = clean(body.alias, 30);
      const contacto = clean(body.contacto, 80);
      const titulo = clean(body.titulo, 90);
      const detalle = cleanLong(body.detalle, 400);
      const cat = CATS.includes(body.cat) ? body.cat : null;
      if (alias.length < 2 || contacto.length < 4 || titulo.length < 4 || !cat) return json({ error: "datos" }, 400);

      const ideas = (mine && mine.ideas) || [];
      if (ideas.length >= MAX_IDEAS) return json({ error: "max" }, 400);
      if (ideas.some((i) => i.titulo.toLowerCase() === titulo.toLowerCase())) return json({ error: "dup" }, 400);
      const last = ideas.length ? ideas[ideas.length - 1].ts : 0;
      if (Date.now() - last < 3000) return json({ error: "lento" }, 429);

      const idea = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), cat, titulo, detalle, ts: Date.now() };
      const next = { alias, contacto, ideas: [...ideas, idea], actualizado: Date.now() };
      await store.setJSON(key, next);
      return json({ uid, mine: next, idea });
    }

    // ---------- organización ----------
    if (path.startsWith("admin/")) {
      const pin = adminPin();
      if (!pin) return json({ error: "nopin" }, 500);
      if ((req.headers.get("x-admin-pin") || "") !== pin) {
        await new Promise((r) => setTimeout(r, 700));
        return json({ error: "pin" }, 401);
      }
      const action = path.slice(6);

      if (action === "login") return json({ ok: true });

      if (action === "all" && !POST) {
        const { blobs } = await store.list({ prefix: "p/" });
        const users = (
          await Promise.all(
            blobs.map(async (b) => {
              const d = await store.get(b.key, { type: "json" });
              return d ? { uid: b.key.slice(2), ...d } : null;
            })
          )
        ).filter(Boolean);
        const borrador = (await store.get("borrador", { type: "json" })) || { sel: [], sup: [] };
        return json({ users, borrador, estado: await getEstado() });
      }

      if (action === "borrador" && POST) {
        const sel = (Array.isArray(body.sel) ? body.sel : []).slice(0, TOTAL).map(winner);
        const sup = (Array.isArray(body.sup) ? body.sup : []).slice(0, 3).map(winner);
        await store.setJSON("borrador", { sel, sup, ts: Date.now() });
        return json({ ok: true });
      }

      if (action === "estado" && POST) {
        const e = {
          cerrado: !!body.cerrado,
          publicado: !!body.publicado,
          ganadores: (Array.isArray(body.ganadores) ? body.ganadores : []).slice(0, TOTAL).map(winner),
          suplentes: (Array.isArray(body.suplentes) ? body.suplentes : []).slice(0, 3).map(winner),
          publicadoEn: body.publicado ? Number(body.publicadoEn) || Date.now() : null,
        };
        await store.setJSON("estado", e);
        return json(e);
      }

      if (action === "delete-idea" && POST) {
        const key = "p/" + clean(body.uid, 40);
        const d = await store.get(key, { type: "json" });
        if (!d) return json({ ok: true });
        const ideas = (d.ideas || []).filter((i) => i.id !== body.ideaId);
        if (ideas.length) await store.setJSON(key, { ...d, ideas });
        else await store.delete(key);
        return json({ ok: true });
      }
    }

    return json({ error: "not_found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "server" }, 500);
  }
};

export const config = { path: "/api/*" };
